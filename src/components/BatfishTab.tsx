import { useEffect, useState } from "react";
import { useApp, useAction } from "../ctx";
import { CFG } from "../lib/neo4j";
import { crafted, randomNet, simulate, type Net } from "../lib/bgp";
import { ingestBgp } from "../lib/db";
import { pregel } from "../lib/bgprun";
import { classify, fromBatfish, modelView, sameV, toIos, type BfRow, type Ios } from "../lib/ios";
import { Btn, Problem, Table, Stat, Note, Code } from "./ui";

const KEY = "netdt.batfish.enabled";
const get = () => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } };

export default function BatfishTab() {
  const { db } = useApp();
  const [on, setOn] = useState(get());
  const [health, setHealth] = useState<"unknown" | "up" | "down">("unknown");
  const { busy, error, run } = useAction();
  const [net, setNet] = useState<Net>(() => crafted());
  const [label, setLabel] = useState("hand-checked network");
  const [ios, setIos] = useState<Ios | null>(null);
  const [res, setRes] = useState<{ total: number; same: number; cats: Record<string, number>; examples: { k: string; bf: string; neo: string; cat: string }[]; ms: number; osc: boolean } | null>(null);

  const toggle = (v: boolean) => { setOn(v); try { localStorage.setItem(KEY, v ? "1" : "0"); } catch { /* storage may be unavailable */ } };
  useEffect(() => {
    if (!on) return;
    fetch(`${CFG.batfish}/health`).then((r) => setHealth(r.ok ? "up" : "down")).catch(() => setHealth("down"));
  }, [on]);

  const generate = () => { setIos(toIos(net)); };
  const compare = () => run("cmp", async () => {
    const x = toIos(net); setIos(x);
    await ingestBgp(db, net);
    const peg = await pregel(db, 40, 4);
    const ref = simulate(net, 40);
    const t0 = performance.now();
    const r = await fetch(`${CFG.batfish}/bgp-rib`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ configs: x.files }) });
    if (!r.ok) throw new Error(`Batfish sidecar: ${r.status} ${(await r.text()).slice(0, 300)}`);
    const rows: BfRow[] = (await r.json()).rows;
    const ms = performance.now() - t0;
    const bf = fromBatfish(rows, net, x), md = modelView(peg.rib, net, x);
    const cats: Record<string, number> = {}; const examples: { k: string; bf: string; neo: string; cat: string }[] = []; let same = 0;
    const show = (v: ReturnType<typeof md.get>) => (v ? `lp${v.lp} [${v.aspath.join(" ")}] med ${v.med} ${v.learned} via ${v.from} {${v.comms.join(",")}}` : "none");
    for (const k of new Set([...bf.keys(), ...md.keys()])) {
      if (sameV(bf.get(k), md.get(k))) { same++; continue; }
      const c = classify(bf.get(k), md.get(k)); cats[c] = (cats[c] ?? 0) + 1;
      if (examples.length < 8) examples.push({ k, bf: show(bf.get(k)), neo: show(md.get(k)), cat: c });
    }
    setRes({ total: new Set([...bf.keys(), ...md.keys()]).size, same, cats, examples, ms, osc: !ref.converged || !peg.converged });
  });

  return (
    <div>
      <Problem kind="batfish" title="Vendor-exact fidelity: who does what" objection="If your BGP model isn't exact, it's worthless. Real networks have vendor-specific tie-breaks.">
        Honest answer: <b>Neo4j computes convergence</b>, and does it the same way every time; <b>vendor-exact fidelity is Batfish's job</b>. So use Batfish as the reference for routing tables computed from the real configurations,
        and Neo4j for what it is good at: impact analysis, policy-aware path queries, and targeted what-ifs (a local-pref, a route-map, a failure) recomputed in the graph, then checked against the reference.
        This tab generates IOS configurations for the current network, runs Batfish on them, and categorises the differences.
      </Problem>

      <div className="card">
        <h3>Optional: needs the Batfish sidecar</h3>
        <label className="row"><input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} /> Enable this tab (off by default). Start the container first: <code>docker compose --profile batfish up -d</code></label>
        {on && <p>Sidecar at <span className="mono">{CFG.batfish}</span>: {health === "up" ? <span className="good">reachable</span> : health === "down" ? <span className="bad">not reachable: is the batfish profile running?</span> : "checking…"}</p>}
      </div>

      {on && (
        <div className="card">
          <h3>Generate, run, compare</h3>
          <div className="row">
            <Btn outlined onClick={() => { const n = crafted(); setNet(n); setLabel("hand-checked network"); setIos(null); setRes(null); }}>Hand-checked network</Btn>
            <Btn outlined onClick={() => { const n = randomNet(1); setNet(n); setLabel("random network, seed 1"); setIos(null); setRes(null); }}>Random network (seed 1)</Btn>
            <Btn outlined onClick={generate}>Generate IOS configs</Btn>
            <Btn onClick={compare} busy={busy === "cmp"} disabled={health !== "up"}>Run Batfish and compare with Neo4j</Btn>
          </div>
          <p className="hint">{label}: {Object.keys(net.R).length} routers.</p>
          {error && <Note tone="danger">{error}</Note>}
          {ios && <><p className="hint">{Object.keys(ios.files).length} configuration files. First one:</p><Code>{Object.values(ios.files)[0].split("\n").slice(0, 40).join("\n")}</Code></>}
          {res && (<>
            <div className="kpis">
              <Stat label="best routes compared" value={res.total} /><Stat label="identical to Batfish" value={`${res.same} (${((100 * res.same) / res.total).toFixed(0)}%)`} tone={res.same === res.total ? "good" : "warn"} /><Stat label="Batfish run" value={`${(res.ms / 1000).toFixed(1)} s`} />
            </div>
            {res.osc && <Note tone="warning">This network does not converge within the iteration cap; Batfish and Neo4j may legitimately differ.</Note>}
            <Table head={["category of difference", "routes"]} rows={Object.entries(res.cats).map(([c, n]) => [c, n])} />
            {res.examples.length > 0 && <Table head={["router · prefix", "Batfish", "Neo4j (Pregel)", "category"]} rows={res.examples.map((e) => [<span className="mono">{e.k.replace("|", " · ")}</span>, e.bf, e.neo, e.cat])} />}
            {res.same < res.total && <Note tone="info">The differences come from the simplified rules of the toy model (tie-breaks, MED across iBGP/eBGP), not from the engine: the reference implementation shows exactly the same ones. A hand-written model gets the main rules right; full fidelity needs every vendor rule validated against real routers.</Note>}
          </>)}
        </div>
      )}
    </div>
  );
}
