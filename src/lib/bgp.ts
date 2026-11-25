// SIMPLIFIED BGP (stated, not hidden), same rules in every implementation: reference (this file), Cypher loop, Pregel, Batfish configs.
//  - One route per (router, prefix) is kept: the best. Only the best is advertised (no add-path).
//  - Transfer over a session a->b, in this order:
//      iBGP split horizon (no iBGP-learned route to an iBGP peer, no route reflectors),
//      export route-map (first match by seq; no match = deny; no route-map = permit all): add community, set MED, AS-path prepend (eBGP only),
//      eBGP: prepend sender ASN, reset LOCAL_PREF to 100, MED kept only if set by the export map else 0,
//      AS-path loop check at the receiver (eBGP), SOO ('soo:<site>' in communities and receiver is in that site -> drop),
//      import route-map: set LOCAL_PREF, add community, permit/deny.
//  - Best path: local origination, then highest LOCAL_PREF, shortest AS-path, lowest MED (always compared), eBGP over iBGP, lowest neighbour router-id.
//  - Not modelled: IGP cost, route reflectors, add-path, aggregation, longest-prefix match.
import { Rng } from "./rng";

export interface Entry { pfx: string; comm: string; act: "permit" | "deny"; lp: number; add: string; med: number; prep: number }
export interface Router { name: string; asn: number; rid: number; orig: string[]; soo: string | null }
export interface Session { a: string; b: string; type: "ebgp" | "ibgp"; exp?: Entry[]; imp?: Entry[] }
export interface Net { R: Record<string, Router>; S: Session[] }
export interface Route { prefix: string; ok: boolean; aspath: number[]; lp: number; med: number; comms: string[]; learned: "local" | "ebgp" | "ibgp"; from_rid: number }
export type Rib = Map<string, Route>; // key "router|prefix"

export const ent = (o: Partial<Entry> = {}): Entry => ({ pfx: "", comm: "", act: "permit", lp: -1, add: "", med: -1, prep: 0, ...o });
const RANK = { local: 0, ebgp: 1, ibgp: 2 } as const;

export function cmpRoute(x: Route, y: Route): number {
  const kx = [x.learned === "local" ? 0 : 1, -x.lp, x.aspath.length, x.med, RANK[x.learned], x.from_rid];
  const ky = [y.learned === "local" ? 0 : 1, -y.lp, y.aspath.length, y.med, RANK[y.learned], y.from_rid];
  for (let i = 0; i < kx.length; i++) if (kx[i] !== ky[i]) return kx[i] - ky[i];
  return 0;
}

function firstMatch(rm: Entry[] | undefined, prefix: string, comms: string[]): number | null {
  if (!rm) return null;
  for (let k = 0; k < rm.length; k++) if ((rm[k].pfx === "" || rm[k].pfx === prefix) && (rm[k].comm === "" || comms.includes(rm[k].comm))) return k;
  return null;
}

export function transfer(st: Route, s: Session, A: Router, B: Router): Route {
  const split = s.type === "ibgp" && st.learned === "ibgp";
  const ek = firstMatch(s.exp, st.prefix, st.comms);
  const eok = !s.exp || (ek !== null && s.exp[ek].act === "permit");
  const p = ek === null ? 0 : s.exp![ek].prep;
  const asp1 = s.type === "ebgp" ? [...Array(p + 1).fill(A.asn), ...st.aspath] : [...st.aspath];
  const comms1 = [...st.comms, ...(ek !== null && s.exp![ek].add !== "" ? [s.exp![ek].add] : [])];
  const med1 = ek !== null && s.exp![ek].med >= 0 ? s.exp![ek].med : s.type === "ebgp" ? 0 : st.med;
  const lp1 = s.type === "ebgp" ? 100 : st.lp;
  const loop = s.type === "ebgp" && asp1.includes(B.asn);
  const soo = B.soo !== null && st.comms.includes("soo:" + B.soo);
  const ik = firstMatch(s.imp, st.prefix, comms1);
  const iok = !s.imp || (ik !== null && s.imp[ik].act === "permit");
  const lp2 = ik !== null && s.imp![ik].lp >= 0 ? s.imp![ik].lp : lp1;
  const comms2 = [...comms1, ...(ik !== null && s.imp![ik].add !== "" ? [s.imp![ik].add] : [])];
  return { prefix: st.prefix, ok: st.ok && !split && !loop && !soo && eok && iok, aspath: asp1, lp: lp2, med: med1, comms: comms2, learned: s.type, from_rid: A.rid };
}

export function localRoutes(R: Record<string, Router>): Rib {
  const out: Rib = new Map();
  for (const r of Object.values(R)) for (const p of r.orig)
    out.set(`${r.name}|${p}`, { prefix: p, ok: true, aspath: [], lp: 100, med: 0, comms: r.soo ? ["soo:" + r.soo] : [], learned: "local", from_rid: r.rid });
  return out;
}

export const canon = (c: Route) => `${c.lp}|${c.aspath.join(" ")}|${c.med}|${c.learned}|${c.from_rid}|${c.comms.join(",")}`;
export const ribEqual = (a: Rib, b: Rib) => a.size === b.size && [...a].every(([k, v]) => b.has(k) && canon(b.get(k)!) === canon(v));

export interface SimResult { rib: Rib; rounds: number; converged: boolean; changedPerRound: number[] }

/** Independent reference: synchronous rounds until a fixed point, or the iteration cap (oscillation). */
export function simulate(net: Net, maxRounds = 40): SimResult {
  const { R, S } = net;
  let rib = localRoutes(R);
  const changed: number[] = [];
  for (let rnd = 1; rnd <= maxRounds; rnd++) {
    const cand = new Map<string, Route[]>();
    for (const [k, c] of localRoutes(R)) cand.set(k, [c]);
    const byRouter = new Map<string, Route[]>();
    for (const [k, c] of rib) { const r = k.slice(0, k.indexOf("|")); (byRouter.get(r) ?? byRouter.set(r, []).get(r)!).push(c); }
    for (const s of S) {
      const A = R[s.a], B = R[s.b];
      for (const c of byRouter.get(s.a) ?? []) {
        const n = transfer(c, s, A, B);
        if (n.ok) { const key = `${s.b}|${c.prefix}`; (cand.get(key) ?? cand.set(key, []).get(key)!).push(n); }
      }
    }
    const next: Rib = new Map();
    for (const [k, v] of cand) next.set(k, v.reduce((x, y) => (cmpRoute(y, x) < 0 ? y : x)));
    let ch = 0;
    for (const [k, v] of next) if (!rib.has(k) || canon(rib.get(k)!) !== canon(v)) ch++;
    for (const k of rib.keys()) if (!next.has(k)) ch++;
    if (ch === 0) return { rib: next, rounds: rnd, converged: true, changedPerRound: changed };
    changed.push(ch);
    rib = next;
  }
  return { rib, rounds: maxRounds, converged: false, changedPerRound: changed };
}

/** Rib after exactly k synchronous rounds (used for the superstep animation). */
export function ribAfter(net: Net, k: number): Rib {
  return simulate(net, k).rib;
}

// ── Hand-checked network: 9 expectations derived by hand ──
export function crafted(): Net {
  const [P1, P2, P3, P4] = ["10.1.0.0/16", "10.2.0.0/16", "10.3.0.0/16", "10.4.0.0/16"];
  const defs: [string, number, string[], string | null][] = [
    ["o1", 100, [P1, P3, P4], "S1"], ["x", 200, [], null], ["y", 300, [], null],
    ["z1", 400, [], null], ["z2", 400, [], null], ["z3", 400, [], null], ["ce2", 500, [P2], "S1"],
  ];
  const R: Record<string, Router> = {};
  defs.forEach(([name, asn, orig, soo], i) => (R[name] = { name, asn, rid: i + 1, orig, soo }));
  const S: Session[] = [];
  for (const [a, b] of [["o1", "x"], ["o1", "y"], ["x", "y"], ["x", "z1"], ["y", "z1"], ["z2", "ce2"]]) S.push({ a, b, type: "ebgp" }, { a: b, b: a, type: "ebgp" });
  for (const [a, b] of [["z1", "z2"], ["z2", "z3"]]) S.push({ a, b, type: "ibgp" }, { a: b, b: a, type: "ibgp" });
  const sess = (a: string, b: string) => S.find((s) => s.a === a && s.b === b)!;
  const ALL = ent();
  sess("y", "x").exp = [ent({ add: "c:9" })];
  sess("x", "z1").imp = [ent({ comm: "c:9", lp: 200 }), ALL];
  sess("o1", "x").imp = [ent({ pfx: P3, act: "deny" }), ALL];
  sess("x", "z1").exp = [ent({ pfx: P4, med: 50 }), ALL];
  sess("y", "z1").exp = [ent({ pfx: P4, med: 10 }), ALL];
  return { R, S };
}

export const CRAFTED_EXPECTED: { router: string; prefix: string; expect: string; why: string }[] = [
  { router: "x", prefix: "10.1.0.0/16", expect: "lp100 aspath 100 ebgp via o1", why: "direct beats via y (shorter AS-path)" },
  { router: "z1", prefix: "10.1.0.0/16", expect: "lp100 aspath 200 100 ebgp via x", why: "x re-advertises its best (untagged): no local-pref 200. Tie with y broken by router-id" },
  { router: "z2", prefix: "10.1.0.0/16", expect: "lp100 aspath 200 100 ibgp via z1", why: "iBGP from z1" },
  { router: "z3", prefix: "10.1.0.0/16", expect: "no route", why: "iBGP split horizon at z2 (no full mesh, no route reflector)" },
  { router: "ce2", prefix: "10.1.0.0/16", expect: "no route", why: "SOO S1: same site as the origin o1" },
  { router: "z1", prefix: "10.2.0.0/16", expect: "lp100 aspath 500 ibgp via z2", why: "routes back through x/y carry AS 400: loop-dropped" },
  { router: "z3", prefix: "10.2.0.0/16", expect: "lp100 aspath 500 ibgp via z2", why: "z2 learned it by eBGP, so it may send it to z3" },
  { router: "x", prefix: "10.3.0.0/16", expect: "lp100 aspath 300 100 ebgp via y", why: "import route-map on o1->x denies 10.3/16" },
  { router: "z1", prefix: "10.4.0.0/16", expect: "lp100 aspath 300 100 med 10 ebgp via y", why: "lower MED wins over lower router-id" },
];

export function describe(c: Route | undefined, R: Record<string, Router>): string {
  if (!c) return "no route";
  const via = Object.values(R).find((r) => r.rid === c.from_rid)?.name ?? "?";
  return `lp${c.lp} aspath ${c.aspath.join(" ") || "-"}${c.med ? ` med ${c.med}` : ""} ${c.learned}${c.learned === "local" ? "" : " via " + via}`;
}

// ── Seeded random networks ──
export function randomNet(seed: number, nAs = 5, perAs: [number, number] = [2, 4], nPrefix = 6, pRm = 0.35): Net {
  const rnd = new Rng(seed);
  const R: Record<string, Router> = {};
  const S: Session[] = [];
  let rid = 1;
  const asns = Array.from({ length: nAs }, (_, i) => 65000 + i);
  const byAs = new Map<number, string[]>();
  for (const a of asns) {
    const n = rnd.int(perAs[0], perAs[1]);
    for (let j = 0; j < n; j++) {
      const name = `r${a % 100}_${j}`;
      R[name] = { name, asn: a, rid: rid++, orig: [], soo: null };
      byAs.set(a, [...(byAs.get(a) ?? []), name]);
    }
  }
  for (const rs of byAs.values()) for (const x of rs) for (const y of rs) if (x !== y) S.push({ a: x, b: y, type: "ibgp" });
  const pairs = new Map<string, [string, string]>();
  const addPair = (x: string, y: string) => pairs.set(`${x}~${y}`, [x, y]);
  for (let i = 1; i < nAs; i++) addPair(rnd.choice(byAs.get(asns[i])!), rnd.choice(byAs.get(asns[rnd.randrange(i)])!));
  for (let i = 0; i < nAs * 2; i++) { const [a1, a2] = rnd.sample(asns, 2); addPair(rnd.choice(byAs.get(a1)!), rnd.choice(byAs.get(a2)!)); }
  for (const key of [...pairs.keys()].sort()) { const [x, y] = pairs.get(key)!; S.push({ a: x, b: y, type: "ebgp" }, { a: y, b: x, type: "ebgp" }); }
  const prefixes = Array.from({ length: nPrefix }, (_, i) => `10.${i}.0.0/16`);
  const names = Object.keys(R);
  for (const p of prefixes) for (const o of rnd.sample(names, rnd.next() < 0.7 ? 1 : 2)) R[o].orig.push(p);
  const sites = rnd.sample(names, 4);
  R[sites[0]].soo = R[sites[1]].soo = "A";
  R[sites[2]].soo = R[sites[3]].soo = "B";
  const comms = ["c:1", "c:2", "c:3"];
  const rm = (kind: "exp" | "imp"): Entry[] => {
    const ents: Entry[] = [];
    for (let i = rnd.int(1, 3); i > 0; i--) {
      ents.push(ent({
        pfx: rnd.choice(["", "", "", ...prefixes]), comm: rnd.choice(["", "", "", ...comms]),
        act: rnd.next() < 0.8 ? "permit" : "deny",
        lp: kind === "imp" ? rnd.choice([-1, 50, 150, 200]) : -1,
        add: rnd.choice(["", "", "c:1", "c:2", "c:3"]),
        med: kind === "exp" ? rnd.choice([-1, -1, 10, 50]) : -1,
        prep: kind === "exp" ? rnd.choice([0, 0, 1, 2]) : 0,
      }));
    }
    if (rnd.next() < 0.7) ents.push(ent());
    return ents;
  };
  for (const s of S) {
    if (rnd.next() < pRm) s.exp = rm("exp");
    if (rnd.next() < pRm) s.imp = rm("imp");
  }
  return { R, S };
}

/** Find a seed whose network converges (or not) for the given size, scanning from `from`. */
export function findNet(opts: { seed: number; converges: boolean; nAs?: number; perAs?: [number, number]; nPrefix?: number; pRm?: number }): { net: Net; seed: number } {
  for (let s = opts.seed; s < opts.seed + 400; s++) {
    const net = randomNet(s, opts.nAs, opts.perAs, opts.nPrefix, opts.pRm);
    if (simulate(net).converged === opts.converges) return { net, seed: s };
  }
  const net = randomNet(opts.seed, opts.nAs, opts.perAs, opts.nPrefix, opts.pRm);
  return { net, seed: opts.seed };
}

// ── Cypher: the per-session transfer function as ONE expression (port of the spike's cypher_transfer) ──
const letIn = (v: string, expr: string, body: string) => `head([${v} IN [${expr}] | ${body}])`;
const firstOf = (rel: string, side: string, prefix: string, comms: string) =>
  `head([k IN range(0, coalesce(size(${rel}.${side}_seq), 0) - 1) WHERE (${rel}.${side}_pfx[k] = '' OR ${rel}.${side}_pfx[k] = ${prefix}) AND (${rel}.${side}_comm[k] = '' OR ${rel}.${side}_comm[k] IN ${comms}) | k])`;

export function cypherTransfer(st: string, r: string, A: string, B: string): string {
  const body =
    `{prefix: ${st}.prefix, ok: ${st}.ok AND NOT (${r}.type = 'ibgp' AND ${st}.learned = 'ibgp')` +
    ` AND NOT (${r}.type = 'ebgp' AND ${B}.asn IN asp1)` +
    ` AND NOT (${B}.soo IS NOT NULL AND ('soo:' + ${B}.soo) IN ${st}.comms)` +
    ` AND (${r}.exp_seq IS NULL OR (ek IS NOT NULL AND ${r}.exp_act[ek] = 'permit'))` +
    ` AND (${r}.imp_seq IS NULL OR (ik IS NOT NULL AND ${r}.imp_act[ik] = 'permit')),` +
    ` aspath: asp1,` +
    ` lp: CASE WHEN ik IS NOT NULL AND ${r}.imp_lp[ik] >= 0 THEN ${r}.imp_lp[ik] WHEN ${r}.type = 'ebgp' THEN 100 ELSE ${st}.lp END,` +
    ` med: med1,` +
    ` comms: comms1 + CASE WHEN ik IS NOT NULL AND ${r}.imp_add[ik] <> '' THEN [${r}.imp_add[ik]] ELSE [] END,` +
    ` learned: ${r}.type, from_rid: ${A}.rid}`;
  let e = letIn("ik", firstOf(r, "imp", `${st}.prefix`, "comms1"), body);
  e = letIn("med1", `CASE WHEN ek IS NOT NULL AND ${r}.exp_med[ek] >= 0 THEN ${r}.exp_med[ek] WHEN ${r}.type = 'ebgp' THEN 0 ELSE ${st}.med END`, e);
  e = letIn("comms1", `${st}.comms + CASE WHEN ek IS NOT NULL AND ${r}.exp_add[ek] <> '' THEN [${r}.exp_add[ek]] ELSE [] END`, e);
  e = letIn("asp1", `CASE WHEN ${r}.type = 'ebgp' THEN [x IN range(0, CASE WHEN ek IS NULL THEN 0 ELSE ${r}.exp_prep[ek] END) | ${A}.asn] + ${st}.aspath ELSE ${st}.aspath END`, e);
  e = letIn("ek", firstOf(r, "exp", `${st}.prefix`, `${st}.comms`), e);
  return e;
}

export const BEST_ORDER =
  "CASE WHEN c.learned = 'local' THEN 0 ELSE 1 END, c.lp DESC, size(c.aspath), c.med, CASE c.learned WHEN 'local' THEN 0 WHEN 'ebgp' THEN 1 ELSE 2 END, c.from_rid";

const LOCAL = "{prefix: p, ok: true, aspath: [], lp: 100, med: 0, comms: CASE WHEN b.soo IS NULL THEN [] ELSE ['soo:' + b.soo] END, learned: 'local', from_rid: b.rid}";
const ST = "{prefix: ra.prefix, ok: true, aspath: ra.aspath, lp: ra.lp, med: ra.med, comms: ra.comms, learned: ra.learned}";

/** One synchronous round, shared by the server-side loop. Reads the current RIB, writes nothing. */
const ROUND_READ = `
CALL () {
  MATCH (a:Router)-[r:BGP]->(b:Router), (a)-[:RIB]->(ra:Route)
  WITH a, r, b, ${ST} AS st
  WITH b, ${cypherTransfer("st", "r", "a", "b")} AS c
  WHERE c.ok
  RETURN b.name AS router, c
  UNION ALL
  MATCH (b:Router) WHERE b.orig IS NOT NULL
  UNWIND b.orig AS p
  RETURN b.name AS router, ${LOCAL} AS c
}`;

/** Server-side fixed-point loop: one committed transaction per round, stops at the first round that changes nothing (1/0 breaks the loop). */
export const SERVER_LOOP = `
UNWIND range(1, $maxRounds) AS loopx
CALL (loopx) {
  ${ROUND_READ}
  WITH router, c ORDER BY ${BEST_ORDER}
  WITH router, c.prefix AS prefix, head(collect(c)) AS best   // aggregation = barrier: every read is done before any write
  MATCH (b:Router {name: router})
  OPTIONAL MATCH (b)-[:RIB]->(old:Route {prefix: prefix})
  CALL (b, old, best, loopx) {
    WHEN old IS NULL THEN {
      CREATE (b)-[:RIB]->(n:Net:Route) SET n = best, n.seen = loopx
      RETURN 1 AS ch }
    WHEN old.lp <> best.lp OR old.aspath <> best.aspath OR old.med <> best.med OR old.learned <> best.learned
         OR old.from_rid <> best.from_rid OR old.comms <> best.comms THEN {
      SET old += best, old.seen = loopx
      RETURN 1 AS ch }
    ELSE {
      SET old.seen = loopx
      RETURN 0 AS ch }
  }
  WITH loopx, sum(ch) AS written
  CALL (loopx) {
    MATCH (gone:Route) WHERE gone.seen <> loopx
    DETACH DELETE gone
    RETURN count(*) AS withdrawn
  }
  RETURN CASE written + withdrawn WHEN 0 THEN 1/0 ELSE written + withdrawn END AS changes
} IN TRANSACTIONS OF 1 ROW ON ERROR BREAK REPORT STATUS AS s
RETURN loopx, s.committed AS committed, changes`;

export const READ_RIB = "MATCH (b:Router)-[:RIB]->(r:Route) RETURN b.name AS router, r.prefix AS prefix, properties(r) AS best";

/** Path enumeration with per-path accumulators (the "BSP/accumulator-style" shortcut): NOT BGP semantics. */
const INIT = "{prefix: pfx, ok: true, aspath: [], lp: 100, med: 0, comms: CASE WHEN o.soo IS NULL THEN [] ELSE ['soo:' + o.soo] END, learned: 'local', from_rid: o.rid}";
const T = cypherTransfer("st", "r", "startNode(r)", "endNode(r)");
export const ENUM_PATHS = `
CALL () {
  MATCH (o:Router) WHERE o.orig IS NOT NULL
  UNWIND o.orig AS pfx
  WITH o, pfx, ${INIT} AS init
  MATCH p = ACYCLIC (o) (()-[rels:BGP]->())+ (x:Router)
  WHERE allReduce(st = init, r IN rels | ${T}, st.ok)
  RETURN x.name AS router, reduce(st = init, r IN rels | ${T}) AS c
  UNION ALL
  MATCH (b:Router) WHERE b.orig IS NOT NULL
  UNWIND b.orig AS p
  RETURN b.name AS router, ${LOCAL} AS c
}
WITH router, c ORDER BY ${BEST_ORDER}
WITH router, c.prefix AS prefix, head(collect(c)) AS best
RETURN router, prefix, best`;

export const routeFromRow = (b: Record<string, unknown>): Route => ({
  prefix: b.prefix as string, ok: true, aspath: (b.aspath as number[]).map(Number), lp: Number(b.lp), med: Number(b.med),
  comms: b.comms as string[], learned: b.learned as Route["learned"], from_rid: Number(b.from_rid),
});

// ── Properties of a session relationship in Neo4j (route-map entries as parallel lists) ──
export function rmProps(rm: Entry[] | undefined, side: "exp" | "imp"): Record<string, unknown> {
  if (!rm) return {};
  return {
    [`${side}_seq`]: rm.map((_, i) => 10 * (i + 1)), [`${side}_pfx`]: rm.map((e) => e.pfx), [`${side}_comm`]: rm.map((e) => e.comm),
    [`${side}_act`]: rm.map((e) => e.act), [`${side}_lp`]: rm.map((e) => e.lp), [`${side}_add`]: rm.map((e) => e.add),
    [`${side}_med`]: rm.map((e) => e.med), [`${side}_prep`]: rm.map((e) => e.prep),
  };
}
export const sessionRows = (S: Session[]) => S.map((x) => ({ a: x.a, b: x.b, p: { type: x.type, ...rmProps(x.exp, "exp"), ...rmProps(x.imp, "imp") } }));
export const routerRows = (R: Record<string, Router>) =>
  Object.values(R).map((r) => ({ name: r.name, asn: r.asn, rid: r.rid, ...(r.orig.length ? { orig: r.orig } : {}), ...(r.soo ? { soo: r.soo } : {}) }));
