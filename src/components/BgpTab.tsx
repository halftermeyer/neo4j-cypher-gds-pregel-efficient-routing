import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, useAction } from "../ctx";
import { ingestBgp } from "../lib/db";
import { crafted, findNet, randomNet, simulate, ribEqual, describe, rmProps, ent, CRAFTED_EXPECTED, type Net, type Rib } from "../lib/bgp";
import { cypherLoop, pregel, enumeratePaths, diffRibs, type Run } from "../lib/bgprun";
import { runQuery, withGroup } from "../lib/neo4j";
import { BgpGraph } from "./Graphs";
import { Btn, Problem, Table, Stat, Note, Verdict, fmt, Code } from "./ui";
import { LoopVsPregelBench } from "./BenchParts";

const MAXIT = 40;

export default function BgpTab() {
  const { db, bump } = useApp();
  const { busy, error, run } = useAction();
  const [net, setNet] = useState<Net>(() => crafted());
  const baseNet = useRef<Net>(net);
  const [label, setLabel] = useState("hand-checked network (7 routers)");
  const [seed, setSeed] = useState(3);
  const [nAs, setNAs] = useState(5);
  const [loaded, setLoaded] = useState(false);
  const [prefix, setPrefix] = useState("10.1.0.0/16");
  const [rib, setRib] = useState<Rib | null>(null);
  const [enumRes, setEnumRes] = useState<{ ref: Rib; en: Rib; ms: number; timedOut: boolean; loopMs: number } | null>(null);
  const [multi, setMulti] = useState<{ nets: number; exact: number; wrong: number; total: number; osc: number } | null>(null);
  const [runs, setRuns] = useState<{ loop?: Run; peg?: Run; ref?: { rib: Rib; rounds: number; converged: boolean; ms: number } }>({});
  const [equiv, setEquiv] = useState<{ nets: number; loopOk: number; pegOk: number; osc: number; oscFlagged: number } | null>(null);
  const [steps, setSteps] = useState<{ rib: Rib; changed: Set<string>; n: number }[]>([]);
  const [cur, setCur] = useState(0); const [playing, setPlaying] = useState(false);
  const [wi, setWi] = useState<{ before: Rib; after: Rib; what: string; ok: boolean; rounds: number; converged: boolean } | null>(null);
  const [wiSess, setWiSess] = useState(""); const [wiKind, setWiKind] = useState("lp"); const [wiVal, setWiVal] = useState(200);

  const prefixes = useMemo(() => [...new Set(Object.values(net.R).flatMap((r) => r.orig))].sort(), [net]);
  const ebgp = useMemo(() => net.S.filter((s) => s.type === "ebgp"), [net]);
  useEffect(() => { if (!prefixes.includes(prefix)) setPrefix(prefixes[0]); }, [prefixes, prefix]);
  useEffect(() => { if (!wiSess && ebgp.length) setWiSess(`${ebgp[0].a}>${ebgp[0].b}`); }, [ebgp, wiSess]);
  useEffect(() => { if (!playing) return; const t = setInterval(() => setCur((c) => { if (c >= steps.length - 1) { setPlaying(false); return c; } return c + 1; }), 1000); return () => clearInterval(t); }, [playing, steps.length]);

  const load = (n: Net, l: string) => run("load", async () => {
    setNet(n); baseNet.current = n; setLabel(l); setRib(null); setEnumRes(null); setRuns({}); setSteps([]); setWi(null);
    await ingestBgp(db, n); setLoaded(true); bump();
  });

  const sectionA = () => run("A", async () => {
    await withGroup("Scenario 6: path enumeration vs the fixed point", async () => {
      const ref = simulate(net, MAXIT);
      const loop = await cypherLoop(db, MAXIT);
      const en = await enumeratePaths(db, 60000);
      setRib(loop.rib); setEnumRes({ ref: loop.rib, en: en.rib, ms: en.ms, timedOut: en.timedOut, loopMs: loop.ms });
      setRuns((r) => ({ ...r, ref: { rib: ref.rib, rounds: ref.rounds, converged: ref.converged, ms: 0 } }));
    });
  });

  const sectionAMany = () => run("Am", async () => {
    await withGroup("Scenario 6: path enumeration on 20 random networks", async () => {
      let exact = 0, wrong = 0, total = 0, nets = 0, osc = 0;
      for (let s = 0; s < 20; s++) {
        const n = randomNet(s); const ref = simulate(n, MAXIT);
        if (!ref.converged) { osc++; continue; }
        await ingestBgp(db, n);
        const en = await enumeratePaths(db, 30000); if (en.timedOut) continue;
        nets++; const d = diffRibs(ref.rib, en.rib).length; wrong += d; total += ref.rib.size; exact += +(d === 0);
        setMulti({ nets, exact, wrong, total, osc });
      }
      await ingestBgp(db, net); setMulti({ nets, exact, wrong, total, osc });
    });
  });

  const runLoop = () => run("loop", async () => { const r = await cypherLoop(db, MAXIT); setRuns((x) => ({ ...x, loop: r })); setRib(r.rib); });
  const runPeg = () => run("peg", async () => { const r = await pregel(db, MAXIT, 4); setRuns((x) => ({ ...x, peg: r })); setRib(r.rib); });
  const runRef = () => run("ref", async () => { const t0 = performance.now(); const r = simulate(net, MAXIT); setRuns((x) => ({ ...x, ref: { rib: r.rib, rounds: r.rounds, converged: r.converged, ms: performance.now() - t0 } })); });

  const equivalence = () => run("eq", async () => {
    await withGroup("Scenario 6: Pregel = Cypher loop = reference on 20 random networks", async () => {
      let loopOk = 0, pegOk = 0, nets = 0, osc = 0, oscFlagged = 0;
      for (let s = 0; s < 20; s++) {
        const n = randomNet(s); const ref = simulate(n, MAXIT);
        await ingestBgp(db, n);
        const l = await cypherLoop(db, MAXIT), p = await pregel(db, MAXIT, 4);
        if (!ref.converged) { osc++; oscFlagged += +(!l.converged && !p.converged); } else { nets++; loopOk += +ribEqual(ref.rib, l.rib); pegOk += +ribEqual(ref.rib, p.rib); }
        setEquiv({ nets, loopOk, pegOk, osc, oscFlagged });
      }
      await ingestBgp(db, net);
    });
  });

  const animate = () => run("anim", async () => {
    await withGroup("Scenario 6: Pregel superstep by superstep (maxIterations = 1, 2, 3 …)", async () => {
      const out: typeof steps = []; let prev: Rib = new Map();
      for (let k = 1; k <= 14; k++) {
        const r = await pregel(db, k, 4);
        const changed = new Set<string>();
        for (const key of new Set([...r.rib.keys(), ...prev.keys()])) { const a = r.rib.get(key), b = prev.get(key); if (!a || !b || JSON.stringify(a) !== JSON.stringify(b)) changed.add(key.split("|")[0]); }
        out.push({ rib: r.rib, changed, n: changed.size }); setSteps([...out]); setCur(k - 1);
        if (changed.size === 0) break; prev = r.rib;
      }
      setCur(0); setPlaying(true);
    });
  });

  const whatIf = (revert = false) => run("wi", async () => {
    await withGroup(revert ? "Scenario 6: revert the what-if" : "Scenario 6: what-if, recompute and diff", async () => {
      if (revert) { await ingestBgp(db, baseNet.current); setNet(baseNet.current); setWi(null); return; }
      const before = (await pregel(db, MAXIT, 4)).rib;
      const [a, b] = wiSess.split(">");
      let what = "";
      const n2: Net = { R: net.R, S: net.S.map((s) => ({ ...s })) };
      if (wiKind === "fail") {
        await runQuery("MATCH (a:Router {name: $a})-[s:BGP]-(b:Router {name: $b}) DELETE s", { a, b }, { database: db });
        n2.S = n2.S.filter((s) => !((s.a === a && s.b === b) || (s.a === b && s.b === a))); what = `session ${a} ↔ ${b} failed`;
      } else {
        const entries = wiKind === "lp" ? [ent({ lp: wiVal })] : [ent({ pfx: prefix, act: "deny" }), ent()];
        await runQuery("MATCH (a:Router {name: $a})-[s:BGP]->(b:Router {name: $b}) SET s += $p", { a, b, p: rmProps(entries, "imp") }, { database: db });
        n2.S.find((s) => s.a === a && s.b === b)!.imp = entries;
        what = wiKind === "lp" ? `import local-pref ${wiVal} on ${a} → ${b}` : `import route-map on ${a} → ${b} denies ${prefix}`;
      }
      const after = await pregel(db, MAXIT, 4); const ref = simulate(n2, MAXIT);
      setNet(n2); setRib(after.rib);
      setWi({ before, after: after.rib, what, ok: after.converged ? ribEqual(ref.rib, after.rib) : !ref.converged, rounds: after.rounds, converged: after.converged });
    });
  });

  const shown = steps.length ? steps[Math.min(cur, steps.length - 1)] : null;
  const showRib = shown?.rib ?? rib ?? undefined;
  const diffEnum = enumRes ? diffRibs(enumRes.ref, enumRes.en) : [];
  const wiDiff = wi ? diffRibs(wi.before, wi.after) : [];
  const rname = (k: string) => k.split("|").join("  ·  ");
  const textOf = (r: Rib | undefined, k: string) => describe(r?.get(k), net.R);

  return (
    <div>
      <Problem kind="bgp" title="BGP is not a path problem" objection="Neo4j can't do BGP convergence. Path queries with accumulators are the way, and that's what the other engines do.">
        A router advertises only its <b>best</b> route per prefix, and which route is best depends on what its neighbours advertise, which depends on their own choices: the network settles into a{" "}
        <b>fixed point</b>. A query that enumerates paths and carries BGP attributes per path (BSP / accumulator style) also counts routes that intermediate routers never advertise.
        Below: the path-enumeration shortcut gets best routes wrong, then the same rules converge twice, with a server-side Cypher loop and with a custom GDS Pregel procedure. Route-maps, local-pref, MED, AS-path, SOO and the iBGP rules are on a toy model: <i>not</i> IGP cost, route reflectors, add-path or longest-prefix match.
      </Problem>

      <div className="card">
        <h3>The network</h3>
        <div className="row">
          <Btn onClick={() => load(crafted(), "hand-checked network (7 routers)")} busy={busy === "load"}>Load the hand-checked network</Btn>
          <label className="sel-label">seed<input className="sel" type="number" style={{ width: 70 }} value={seed} onChange={(e) => setSeed(+e.target.value)} /></label>
          <label className="sel-label">ASes<input className="sel" type="number" style={{ width: 60 }} min={3} max={30} value={nAs} onChange={(e) => setNAs(+e.target.value)} /></label>
          <Btn outlined onClick={() => load(randomNet(seed, nAs), `random network, seed ${seed}, ${nAs} ASes`)} busy={busy === "load"}>Load random</Btn>
          <Btn outlined onClick={() => { const r = findNet({ seed, converges: false, nAs }); setSeed(r.seed); load(r.net, `oscillating network, seed ${r.seed}`); }} busy={busy === "load"}>Find an oscillating one</Btn>
        </div>
        <p className="hint">{label}: {Object.keys(net.R).length} routers, {net.S.length} directed sessions. Seeded generator: same seed, same network.</p>
        {error && <Note tone="danger">{error}</Note>}
        <div className="row"><label className="sel-label">prefix shown<select className="sel" value={prefix} onChange={(e) => setPrefix(e.target.value)}>{prefixes.map((p) => <option key={p}>{p}</option>)}</select></label>
          <span className="legend"><span><i style={{ background: "#2e7d32" }} />origin</span><span><i style={{ background: "#006fd6" }} />has a route (arrow = learned from)</span><span><i style={{ background: "#c9d1dd" }} />no route</span><span><i style={{ background: "#f9a825" }} />changed this superstep</span></span></div>
        <BgpGraph net={net} rib={showRib} prefix={prefix} changed={shown?.changed} />
      </div>

      <div className="card">
        <h3>A · Path enumeration with per-path accumulators vs the fixed point</h3>
        <div className="row"><Btn onClick={sectionA} busy={busy === "A"} disabled={!loaded}>Run both on this network</Btn><Btn outlined onClick={sectionAMany} busy={busy === "Am"} disabled={!loaded}>Run on 20 random networks</Btn></div>
        {enumRes && (<>
          <div className="kpis">
            <Stat label="best routes (fixed point)" value={enumRes.ref.size} sub={`Cypher loop ${fmt(enumRes.loopMs)}`} />
            <Stat label="wrong with path enumeration" value={enumRes.timedOut ? "timeout" : `${diffEnum.length}`} tone={diffEnum.length ? "bad" : "good"} sub={`${fmt(enumRes.ms)}${enumRes.timedOut ? " (server-side timeout)" : ""}`} />
          </div>
          {diffEnum.length > 0 && <Table head={["router · prefix", "fixed point (BGP semantics)", "path enumeration says"]} rows={diffEnum.slice(0, 8).map((d) => [<span className="mono">{rname(d.key)}</span>, textOf(enumRes.ref, d.key), <span className="bad">{textOf(enumRes.en, d.key)}</span>])} />}
        </>)}
        {multi && <div className="kpis"><Stat label="networks (converging)" value={multi.nets} sub={`${multi.osc} oscillating skipped`} /><Stat label="exact with path enumeration" value={`${multi.exact} / ${multi.nets}`} tone={multi.exact === multi.nets ? "good" : "bad"} /><Stat label="wrong best routes" value={`${multi.wrong} / ${multi.total}`} sub={`${multi.total ? ((100 * multi.wrong) / multi.total).toFixed(0) : 0}%`} tone="bad" /></div>}
        <p className="hint">Why: router X picks a direct route and advertises only that one; a downstream route-map prefers routes tagged by Y. The path query sees a tagged route through Y and X and picks it. The real network never advertises it.</p>
      </div>

      <div className="card">
        <h3>B · Converge it twice, and prove they agree</h3>
        <div className="row"><Btn onClick={runLoop} busy={busy === "loop"} disabled={!loaded}>Cypher loop (server side)</Btn><Btn onClick={runPeg} busy={busy === "peg"} disabled={!loaded}>GDS Pregel</Btn><Btn outlined onClick={runRef} busy={busy === "ref"}>Reference (TypeScript)</Btn></div>
        <div className="kpis">
          {runs.loop && <Stat label="Cypher loop" value={fmt(runs.loop.ms)} sub={`${runs.loop.rounds} rounds · changes/round ${runs.loop.changes?.join(", ")}`} tone={runs.loop.converged ? "good" : "warn"} />}
          {runs.peg && <Stat label="GDS Pregel" value={fmt(runs.peg.ms)} sub={`${runs.peg.rounds} supersteps · ${runs.peg.converged ? "converged" : "NOT converged"}`} tone={runs.peg.converged ? "good" : "warn"} />}
          {runs.ref && <Stat label="Reference" value={`${runs.ref.rounds} rounds`} sub={runs.ref.converged ? "converged" : "NOT converged"} />}
        </div>
        {[runs.loop, runs.peg, runs.ref].some((x) => x && !x.converged) && <Note tone="warning">Oscillation: no fixed point within {MAXIT} iterations (conflicting local-pref policies). Every engine stops at the cap and flags it instead of returning a made-up answer.</Note>}
        {runs.loop && runs.peg && <p>Pregel = Cypher loop: <Verdict ok={ribEqual(runs.loop.rib, runs.peg.rib)}>{ribEqual(runs.loop.rib, runs.peg.rib) ? "identical routing tables" : "DIFFERENT"}</Verdict> {runs.ref && <> · both = reference: <Verdict ok={ribEqual(runs.ref.rib, runs.peg.rib) && ribEqual(runs.ref.rib, runs.loop.rib)}>{ribEqual(runs.ref.rib, runs.peg.rib) ? "yes" : "no"}</Verdict></>}</p>}
        <div className="row"><Btn outlined onClick={equivalence} busy={busy === "eq"} disabled={!loaded}>Equivalence check on 20 random networks</Btn></div>
        {equiv && <div className="kpis"><Stat label="Cypher loop = reference" value={`${equiv.loopOk} / ${equiv.nets}`} tone={equiv.loopOk === equiv.nets ? "good" : "bad"} /><Stat label="Pregel = reference" value={`${equiv.pegOk} / ${equiv.nets}`} tone={equiv.pegOk === equiv.nets ? "good" : "bad"} /><Stat label="oscillating, flagged by both" value={`${equiv.oscFlagged} / ${equiv.osc}`} tone={equiv.oscFlagged === equiv.osc ? "good" : "bad"} /></div>}
        {label.startsWith("hand") && runs.peg && <Table head={["router · prefix", "expected (derived by hand)", "Pregel", "why"]} rows={CRAFTED_EXPECTED.map((e) => { const got = describe(runs.peg!.rib.get(`${e.router}|${e.prefix}`), net.R); return [<span className="mono">{e.router} · {e.prefix}</span>, e.expect, <Verdict ok={got.replace(/lp100 /, "lp100 ") === e.expect || got.startsWith(e.expect.split(" via")[0])}>{got}</Verdict>, <span className="hint">{e.why}</span>]; })} />}
        <Code>{`-- the server-side loop: one committed transaction per round, 1/0 breaks it at the first round with no change
UNWIND range(1, $maxRounds) AS loopx
CALL (loopx) { /* read neighbours' best, apply session policies, keep the best per router+prefix, write only what changed */
  RETURN CASE changes WHEN 0 THEN 1/0 ELSE changes END AS changes
} IN TRANSACTIONS OF 1 ROW ON ERROR BREAK

-- the Pregel version: same loop as BSP supersteps, in memory, in parallel
CALL gds.graph.project('net_bgp', 'Router', 'BGP');
CALL netdt.bgp.pregel('net_bgp', 40, 4, 'neo4j');`}</Code>
        <p className="hint">The Pregel procedure is a custom plugin: it needs a GDS licence in production (unlicensed GDS caps concurrency at 4) and would need hardening before production use.</p>
      </div>

      <div className="card">
        <h3>C · Watch it converge, superstep by superstep</h3>
        <div className="row"><Btn onClick={animate} busy={busy === "anim"} disabled={!loaded}>Compute supersteps with Pregel and play</Btn>
          {steps.length > 0 && <><Btn outlined onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</Btn><input type="range" min={0} max={steps.length - 1} value={Math.min(cur, steps.length - 1)} onChange={(e) => { setPlaying(false); setCur(+e.target.value); }} /></>}</div>
        <p className="hint">Each frame is a real Pregel run with <code>maxIterations = k</code>: the routing tables after k supersteps. Amber = routers whose table changed in that superstep.</p>
        {steps.length > 0 && <Table head={["superstep", ...steps.map((_, i) => `${i + 1}`)]} rows={[["routers changed", ...steps.map((s) => s.n)], ["best routes", ...steps.map((s) => s.rib.size)]]} />}
        {steps.length > 0 && steps[steps.length - 1].n > 0 && <Note tone="warning">Still changing after {steps.length} supersteps: this network oscillates.</Note>}
        {shown && <p className="hint">Superstep {cur + 1}: <b>{[...shown.changed].join(", ") || "nothing changed: fixed point"}</b></p>}
      </div>

      <div className="card">
        <h3>D · What-if: change a policy, recompute, diff the routing tables</h3>
        <div className="row">
          <label className="sel-label">eBGP session<select className="sel" value={wiSess} onChange={(e) => setWiSess(e.target.value)}>{ebgp.map((s) => <option key={`${s.a}>${s.b}`} value={`${s.a}>${s.b}`}>{s.a} → {s.b}</option>)}</select></label>
          <label className="sel-label">change<select className="sel" value={wiKind} onChange={(e) => setWiKind(e.target.value)}><option value="lp">set import local-pref</option><option value="deny">route-map: deny the shown prefix on import</option><option value="fail">fail the session</option></select></label>
          {wiKind === "lp" && <label className="sel-label">local-pref<input className="sel" type="number" style={{ width: 80 }} value={wiVal} onChange={(e) => setWiVal(+e.target.value)} /></label>}
          <Btn onClick={() => whatIf()} busy={busy === "wi"} disabled={!loaded}>Apply, recompute, diff</Btn><Btn outlined onClick={() => whatIf(true)} disabled={!loaded}>Revert</Btn>
        </div>
        {wi && (<>
          <p><b>{wi.what}</b>: {wiDiff.length} routing-table entries changed ({wi.converged ? `${wi.rounds} supersteps` : "no convergence: oscillation"}). Matches the reference: <Verdict ok={wi.ok}>{wi.ok ? "yes" : "no"}</Verdict></p>
          <Table head={["router · prefix", "before", "after"]} rows={wiDiff.slice(0, 15).map((d) => [<span className="mono">{rname(d.key)}</span>, textOf(wi.before, d.key), <b>{textOf(wi.after, d.key)}</b>])} />
        </>)}
      </div>

      <LoopVsPregelBench />
    </div>
  );
}
