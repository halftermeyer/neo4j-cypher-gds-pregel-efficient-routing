// Three ways to compute BGP best routes inside Neo4j, plus the reference. All return the same Rib shape.
import neo4j from "neo4j-driver";
import { runQuery, CFG } from "./neo4j";
import { ENUM_PATHS, READ_RIB, SERVER_LOOP, canon, routeFromRow, ribEqual, type Rib } from "./bgp";

export interface Run { rib: Rib; rounds: number; converged: boolean; ms: number; changes?: number[] }

const toRib = (rows: { router: string; prefix: string; best: Record<string, unknown> }[]): Rib => {
  const m: Rib = new Map();
  for (const r of rows) m.set(`${r.router}|${r.prefix}`, routeFromRow(r.best));
  return m;
};

/** Server-side fixed point: ONE Cypher statement, one committed transaction per round, stops at the first round with no change. */
export async function cypherLoop(db: string, maxRounds = 40, opts: { timeoutMs?: number } = {}): Promise<Run> {
  await runQuery("MATCH (r:Route) DETACH DELETE r", {}, { database: db });
  const t0 = performance.now();
  // TransactionConfig.timeout is in milliseconds
  const rows = await runQuery<{ loopx: number; committed: boolean; changes: number }>(SERVER_LOOP, { maxRounds }, { database: db, timeoutMs: opts.timeoutMs });
  const ms = performance.now() - t0;
  const done = rows.filter((r) => r.committed);
  const converged = done.length < rows.length; // the round that failed on 1/0 found no change: fixed point
  const rib = toRib(await runQuery(READ_RIB, {}, { database: db }));
  return { rib, rounds: done.length + (converged ? 1 : 0), converged, ms, changes: done.map((r) => Number(r.changes)) };
}

/** GDS Pregel: the same loop as BSP supersteps, in memory and in parallel. */
export async function pregel(db: string, maxIter = 40, concurrency = 4): Promise<Run> {
  const g = "net_bgp";
  await runQuery("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", { g }, { database: db, silent: true });
  const t0 = performance.now();
  await runQuery("CALL gds.graph.project($g, 'Router', 'BGP') YIELD nodeCount, relationshipCount", { g }, { database: db });
  const rows = await runQuery<{ router: string; prefix: string; lp: number; aspath: number[]; med: number; learned: string; fromRid: number; comms: string[]; iterations: number; converged: boolean }>(
    "CALL netdt.bgp.pregel($g, $maxIter, $conc, $user)", { g, maxIter, conc: concurrency, user: CFG.user }, { database: db });
  const ms = performance.now() - t0;
  await runQuery("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", { g }, { database: db });
  const rib: Rib = new Map();
  for (const r of rows) rib.set(`${r.router}|${r.prefix}`, { prefix: r.prefix, ok: true, aspath: r.aspath.map(Number), lp: Number(r.lp), med: Number(r.med), comms: r.comms, learned: r.learned as "ebgp", from_rid: Number(r.fromRid) });
  return { rib, rounds: rows[0] ? Number(rows[0].iterations) : 0, converged: rows[0] ? rows[0].converged : true, ms };
}

/** Path enumeration with per-path accumulators: not BGP semantics, shown to be wrong. */
export async function enumeratePaths(db: string, timeoutMs = 60000): Promise<{ rib: Rib; ms: number; timedOut: boolean }> {
  const t0 = performance.now();
  try {
    const rows = await runQuery<{ router: string; prefix: string; best: Record<string, unknown> }>(ENUM_PATHS, {}, { database: db, timeoutMs });
    return { rib: toRib(rows), ms: performance.now() - t0, timedOut: false };
  } catch (e) {
    if (/timed out|transaction.*terminated|Timeout/i.test((e as Error).message)) return { rib: new Map(), ms: performance.now() - t0, timedOut: true };
    throw e;
  }
}

export interface RibDiff { key: string; a?: string; b?: string }
export function diffRibs(a: Rib, b: Rib): RibDiff[] {
  const out: RibDiff[] = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k), y = b.get(k);
    if (!x || !y || canon(x) !== canon(y)) out.push({ key: k, a: x && canon(x), b: y && canon(y) });
  }
  return out.sort((p, q) => (p.key < q.key ? -1 : 1));
}
export { ribEqual, neo4j };
