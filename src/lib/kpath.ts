// Policy-aware K cheapest paths: Cypher evaluates the ACLs for ONE flow, GDS runs Yen on what is left.
import { runQuery, toJS, getDriver } from "./neo4j";
import { BLOCKED_LIST_MODEL, BLOCKED_NODE_MODEL, HOP_DECISIONS, PLANT_DENY, CLEAR_PLANTED, PROJECT_BASE, PROJECT_PER_FLOW, YEN, qppQuery } from "./cypher";
import type { Flow } from "./topology";

export interface PathRes { index: number; cost: number; ifs: string[]; devs: string[] }
export interface Timings { blocked?: number; filter?: number; project?: number; yen: number; drop: number; total: number; nblocked?: number; rels?: number }
export const BASE = "net_base";
let seq = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

const now = () => performance.now();
const isMissingNode = (e: unknown) => /do not exist in the in-memory graph|not.*exist in the.*graph|empty graph|no relationships|must not be empty/i.test((e as Error).message);

/** Collapse in/out interface pairs: one device per hop. */
export const deviceSeq = (devs: string[]) => devs.filter((d, i) => i === 0 || d !== devs[i - 1]);

export async function projectBase(db: string, name = BASE) {
  await runQuery("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", { g: name }, { database: db });
  const t0 = now();
  const r = await runQuery<{ g: { nodeCount: number; relationshipCount: number } }>(PROJECT_BASE, { g: name }, { database: db });
  return { ms: now() - t0, nodes: r[0].g.nodeCount, rels: r[0].g.relationshipCount };
}

export async function ensureBase(db: string, name = BASE) {
  const r = await runQuery<{ exists: boolean }>("CALL gds.graph.exists($g) YIELD exists RETURN exists", { g: name }, { database: db, silent: true });
  return r[0].exists ? null : projectBase(db, name);
}

export async function blockedSet(db: string, flow: Flow, model: "list" | "node" = "list", opts: { silent?: boolean } = {}) {
  const r = await runQuery<{ blocked: number[] }>(model === "list" ? BLOCKED_LIST_MODEL : BLOCKED_NODE_MODEL, { flow }, { database: db, silent: opts.silent });
  return r[0].blocked.map(Number);
}

async function yen(db: string, g: string, flow: Flow, k: number, silent?: boolean): Promise<PathRes[]> {
  try {
    return await runQuery<PathRes>(YEN, { g, src: flow.src_host, dst: flow.dst_host, k }, { database: db, silent });
  } catch (e) {
    if (isMissingNode(e)) return []; // Yen raises when an endpoint was filtered out: that simply means "no permitted path"
    throw e;
  }
}

export interface HybridOpts { k?: number; xdid?: number[]; xlid?: number[]; model?: "list" | "node"; base?: string; silent?: boolean; blocked?: number[] }

/** Hybrid: one base projection + gds.graph.filter per flow. Failed devices and links are excluded at filter time. */
export async function hybrid(db: string, flow: Flow, o: HybridOpts = {}): Promise<{ paths: PathRes[]; t: Timings }> {
  const k = o.k ?? 5, silent = o.silent;
  const t0 = now();
  const blocked = o.blocked ?? (await blockedSet(db, flow, o.model ?? "list", { silent }));
  const t1 = now();
  const nodeExpr = [...blocked.map((b) => `n.nid <> ${b}`), ...(o.xdid ?? []).map((d) => `n.did <> ${d}`)].join(" AND ") || "true";
  const relExpr = (o.xlid ?? []).map((l) => `r.lid <> ${l}`).join(" AND ") || "*";
  const g = uid("net_h");
  let rels = 0, paths: PathRes[] = [];
  try {
    const f = await runQuery<{ n: number }>("CALL gds.graph.filter($g, $base, $nodes, $rels) YIELD relationshipCount RETURN relationshipCount AS n", { g, base: o.base ?? BASE, nodes: nodeExpr, rels: relExpr }, { database: db, silent });
    rels = f[0].n;
    var t2 = now();
    paths = await yen(db, g, flow, k, silent);
  } catch (e) {
    if (!isMissingNode(e)) throw e;
    t2 = now();
  }
  const t3 = now();
  await runQuery("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", { g }, { database: db, silent });
  const t4 = now();
  return { paths, t: { blocked: t1 - t0, filter: (t2 ?? t1) - t1, yen: t3 - (t2 ?? t3), drop: t4 - t3, total: t4 - t0, nblocked: blocked.length, rels } };
}

/** Variant (a): a Cypher projection of the allowed edges only, per request. Always current, slower. */
export async function perRequest(db: string, flow: Flow, o: { k?: number; xdev?: string[]; xlink?: number[]; applyAcl?: boolean; silent?: boolean } = {}): Promise<{ paths: PathRes[]; t: Timings }> {
  const g = uid("net_g"), silent = o.silent;
  const t0 = now();
  let rels = 0;
  const r = await runQuery<{ rels: number }>(PROJECT_PER_FLOW, { flow, g, xdev: o.xdev ?? [], xlink: o.xlink ?? [], applyAcl: o.applyAcl ?? true }, { database: db, silent });
  rels = r[0]?.rels ?? 0;
  const t1 = now();
  let paths: PathRes[] = [];
  try { paths = await yen(db, g, flow, o.k ?? 5, silent); } finally {
    var t2 = now();
    await runQuery("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", { g }, { database: db, silent });
  }
  const t3 = now();
  return { paths, t: { project: t1 - t0, yen: t2 - t1, drop: t3 - t2, total: t3 - t0, rels } };
}

/** Plain Yen on the base projection, no policy at all: the "physical shortest paths" the post-filter trap starts from. */
export async function rawYen(db: string, flow: Flow, k: number, base = BASE): Promise<PathRes[]> {
  return runQuery<PathRes>(YEN, { g: base, src: flow.src_host, dst: flow.dst_host, k }, { database: db });
}

export interface Hop { pos: number; device: string; inIf: string; outIf: string; inList: { seq: number; action: string } | null; outList: { seq: number; action: string } | null; inHasAcl: boolean; outHasAcl: boolean; inNode: { seq: number | null; action: string | null }; outNode: { seq: number | null; action: string | null } }

export async function hopDecisions(db: string, flow: Flow, ifs: string[]): Promise<Hop[]> {
  return runQuery<Hop>(HOP_DECISIONS, { flow, ifs }, { database: db });
}

/** Verdict of one decision: no ACL -> permit; ACL but no matching ACE -> implicit deny. */
export function decide(hasAcl: boolean, d: { seq: number | null; action: string | null } | null): { permit: boolean; text: string } {
  if (!hasAcl) return { permit: true, text: "no ACL: permit" };
  if (!d || d.seq === null || d.seq === undefined) return { permit: false, text: "no ACE matches: implicit deny" };
  return { permit: d.action === "permit", text: `ACE ${d.seq}: ${d.action}` };
}
export const hopPermit = (h: Hop) => decide(h.inHasAcl, h.inList).permit && decide(h.outHasAcl, h.outList).permit;
export const hopPermitNode = (h: Hop) => decide(h.inHasAcl, h.inNode).permit && decide(h.outHasAcl, h.outNode).permit;
/** Do both storages decide identically at this hop? */
export function hopAgree(h: Hop): boolean {
  const key = (hasAcl: boolean, d: { seq: number | null; action: string | null } | null) => (hasAcl ? `${d?.seq ?? "none"}:${d?.action ?? "deny"}` : "noacl");
  return key(h.inHasAcl, h.inList) === key(h.inHasAcl, h.inNode) && key(h.outHasAcl, h.outList) === key(h.outHasAcl, h.outNode);
}

export async function pathPermitted(db: string, flow: Flow, ifs: string[]): Promise<boolean> {
  const hops = await hopDecisions(db, flow, ifs);
  return hops.every(hopPermit);
}

/** Cypher QPP with allReduce budget (scenario 3). */
export async function qpp(db: string, flow: Flow, budget: number, k = 5, timeoutMs = 30000): Promise<{ paths: PathRes[]; ms: number }> {
  const t0 = now();
  const rows = await runQuery<PathRes>(qppQuery(true), { flow, budget, k }, { database: db, timeoutMs });
  return { paths: rows.map((r, i) => ({ ...r, index: i })), ms: now() - t0 };
}

export const plantDeny = (db: string, name: string, port: number) => runQuery(PLANT_DENY, { name, port }, { database: db });
export const clearPlanted = (db: string) => runQuery(CLEAR_PLANTED, {}, { database: db });

/** Run fn with a dedicated session-less concurrency level (browser-side). */
export async function pool<T, R>(items: T[], width: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export const costsOf = (p: PathRes[]) => p.map((x) => x.cost);
export const sameCosts = (a: PathRes[], b: PathRes[]) => a.length === b.length && a.every((x, i) => Math.abs(x.cost - b[i].cost) < 1e-9);
export const samePaths = (a: PathRes[], b: PathRes[]) => a.length === b.length && a.every((x, i) => x.ifs.join(">") === b[i].ifs.join(">"));
export { toJS, getDriver };
