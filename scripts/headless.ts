// Headless smoke/equivalence run against the running Neo4j (same libraries as the UI). Usage: npm run test:equiv
import { readFileSync } from "node:fs";
const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
(globalThis as any).__CFG__ = { uri: env.NEO4J_URI, user: env.NEO4J_USER, password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE || "neo4j", batfish: "" };
const { resetDemo, ingestTopology, ingestBgp, stats } = await import("../src/lib/db.ts");
const { generateTopology, seededFlows, flowOf } = await import("../src/lib/topology.ts");
const K = await import("../src/lib/kpath.ts");
const B = await import("../src/lib/bgp.ts");
const { getDriver, runQuery } = await import("../src/lib/neo4j.ts");
const db = (globalThis as any).__CFG__.database;
const ok = (c: boolean, m: string) => console.log(`${c ? "PASS" : "FAIL"} ${m}`);

await resetDemo(db);
const topo = generateTopology();
let t = performance.now();
await ingestTopology(db, topo);
await ingestBgp(db, B.crafted());
console.log("ingest ms", Math.round(performance.now() - t), JSON.stringify(await stats(db)));
const base = await K.projectBase(db);
console.log("base projection", base);
const flows = seededFlows(topo.devices, 20);
let eq = 0, eqn = 0, rawVsH = 0; const th: number[] = [], ta: number[] = [];
for (const f of flows) {
  const h = await K.hybrid(db, f, { k: 5 });
  const a = await K.perRequest(db, f, { k: 5 });
  const hn = await K.hybrid(db, f, { k: 5, model: "node" });
  th.push(h.t.total); ta.push(a.t.total);
  eq += +K.sameCosts(h.paths, a.paths); eqn += +K.sameCosts(h.paths, hn.paths);
}
ok(eq === flows.length, `hybrid == per-request on ${eq}/${flows.length}`);
ok(eqn === flows.length, `list model == node model on ${eqn}/${flows.length}`);
const med = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
console.log("median ms hybrid", Math.round(med(th)), "per-request", Math.round(med(ta)));
// QPP vs Yen
let qq = 0, n = 0;
for (const f of flows.slice(0, 10)) {
  const y = (await K.hybrid(db, f, { k: 5 })).paths;
  const budget = y.length ? y[0].cost * 1.3 : 100;
  const yy = y.filter((p) => p.cost <= budget);
  const q = (await K.qpp(db, f, budget, 5)).paths;
  n++; qq += +K.sameCosts(yy, q);
}
ok(qq === n, `QPP == Yen on ${qq}/${n}`);

// ---- BGP: crafted + random ----
const R = await import("../src/lib/bgprun.ts");
await ingestBgp(db, B.crafted());
const net0 = B.crafted(); const ref0 = B.simulate(net0);
const c0 = await R.cypherLoop(db), p0 = await R.pregel(db), e0 = await R.enumeratePaths(db);
ok(B.ribEqual(ref0.rib, c0.rib), "crafted: Cypher loop == reference");
ok(B.ribEqual(ref0.rib, p0.rib), "crafted: Pregel == reference");
console.log("crafted: path enumeration wrong routes:", R.diffRibs(ref0.rib, e0.rib).length, "of", ref0.rib.size, "| rounds", c0.rounds, p0.rounds);
let nr = 0, okc = 0, okp = 0, wrongEnum = 0, tot = 0, osc = 0, oscDetected = 0;
for (let seed = 0; seed < 20; seed++) {
  const net = B.randomNet(seed); const ref = B.simulate(net);
  await ingestBgp(db, net);
  const c = await R.cypherLoop(db), p = await R.pregel(db);
  if (!ref.converged) { osc++; oscDetected += +(!c.converged && !p.converged); continue; }
  nr++; okc += +B.ribEqual(ref.rib, c.rib); okp += +B.ribEqual(ref.rib, p.rib);
  const e = await R.enumeratePaths(db, 30000); if (!e.timedOut) { tot += ref.rib.size; wrongEnum += R.diffRibs(ref.rib, e.rib).length; }
}
ok(okc === nr, `random: Cypher loop == reference ${okc}/${nr}`);
ok(okp === nr, `random: Pregel == reference ${okp}/${nr}`);
console.log(`oscillating nets ${osc}, flagged by both engines ${oscDetected}; path enumeration wrong ${wrongEnum}/${tot} best routes`);
await getDriver().close();
