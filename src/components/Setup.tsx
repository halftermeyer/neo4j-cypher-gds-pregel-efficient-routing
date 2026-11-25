import { useCallback, useEffect, useState } from "react";
import { useApp, useAction } from "../ctx";
import { checkConnection, ingestBgp, ingestTopology, resetDemo, stats, type DbStats } from "../lib/db";
import { generateTopology } from "../lib/topology";
import { crafted } from "../lib/bgp";
import { projectBase, BASE } from "../lib/kpath";
import { runQuery, withGroup, CFG } from "../lib/neo4j";
import { Btn, Banner, Stat, fmt } from "./ui";

export default function Setup() {
  const { db, setTopo, bump, version, topo } = useApp();
  const [conn, setConn] = useState<Awaited<ReturnType<typeof checkConnection>> | null>(null);
  const [st, setSt] = useState<DbStats | null>(null);
  const [steps, setSteps] = useState<{ label: string; ms: number }[]>([]);
  const [campuses, setCampuses] = useState(24);
  const [dcs, setDcs] = useState(10);
  const { busy, error, run } = useAction();

  const refresh = useCallback(async () => {
    const c = await checkConnection();
    setConn(c);
    if (c.ok) setSt(await stats(db).catch(() => null));
  }, [db]);
  useEffect(() => { refresh(); }, [refresh, version]);

  const timed = async (label: string, fn: () => Promise<unknown>, acc: { label: string; ms: number }[]) => {
    const t0 = performance.now();
    await fn();
    acc.push({ label, ms: performance.now() - t0 });
    setSteps([...acc]);
  };

  const ingest = () => run("ingest", async () => {
    const acc: { label: string; ms: number }[] = [];
    setSteps([]);
    await withGroup("Bootstrap from an empty database", async () => {
      await timed("Reset (only :Net data)", () => resetDemo(db), acc);
      const t = generateTopology({ campuses, dcs });
      await timed(`Ingest topology: ${t.devices.length} devices, ${t.ifaces.length} interface nodes, ${t.aceCount} ACEs (two storage models)`, () => ingestTopology(db, t), acc);
      await runQuery("MERGE (m:Net:Meta) SET m.seed = 42, m.campuses = $c, m.dcs = $d", { c: campuses, d: dcs }, { database: db });
      await timed("Ingest the hand-checked BGP network", () => ingestBgp(db, crafted()), acc);
      await timed("Project the base GDS graph (once)", () => projectBase(db, BASE), acc);
      setTopo(t);
    });
    bump();
  });

  const reset = () => run("reset", async () => { await resetDemo(db); setTopo(null); setSteps([]); bump(); });
  const empty = !st || st.devices === 0;

  return (
    <div>
      <div className="problem">
        <div className="problem-text">
          <div className="problem-tag">The story</div>
          <h2>“Neo4j can't do policy-aware K-paths or BGP convergence.”</h2>
          <div className="problem-body">
            An international bank is comparing graph engines for its network digital twin. It has been told that BSP / accumulator-based graph engines handle
            policy-aware routing and BGP, and that Neo4j does not. The next seven tabs take each objection in turn and answer it <b>live</b>: the real queries and
            the real algorithm run in front of you, every statement is in the Cypher drawer on the right, and every number comes from this instance.
            <br /><br />Start here: the database is empty. Ingestion is part of the story, and it runs from this page.
          </div>
        </div>
        <div className="problem-visual">
          <ol className="hint" style={{ lineHeight: 1.8, fontSize: 13 }}>
            <li><b>ACL model</b>: which ACE decides at each hop</li><li><b>K permitted paths</b>: the post-filter trap</li><li><b>Pruning in Cypher</b>: QPP + allReduce</li>
            <li><b>Freshness &amp; scale</b>: live, up to 300k ACEs</li><li><b>VRF</b>: isolation and leaks</li><li><b>BGP</b>: a fixed point, not a path search</li><li><b>Fidelity</b>: against Batfish</li>
          </ol>
        </div>
      </div>

      {!conn?.ok && conn && <Banner variant="danger">Cannot reach Neo4j at {CFG.uri}: {conn.message}. Check NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD in .env, then restart <code>npm run dev</code>.</Banner>}
      {conn?.ok && !conn.gds && <Banner variant="danger">Connected, but GDS is not installed on this server.</Banner>}
      {conn?.ok && conn.gds && !conn.pregel && <Banner variant="warning">GDS {conn.gds} found, but the custom procedure <code>netdt.bgp.pregel</code> is not registered. Scenario 6 can still run the Cypher loop. Build it with <code>docker compose up -d --build</code> (see README).</Banner>}

      <div className="card">
        <h3>Connection</h3>
        <div className="kpis">
          <Stat label="Neo4j" value={conn?.ok ? "connected" : "…"} sub={`${CFG.uri} · db “${db}”`} tone={conn?.ok ? "good" : undefined} />
          <Stat label="GDS" value={conn?.gds ?? "–"} sub="Unlicensed GDS caps concurrency at 4" />
          <Stat label="Pregel procedure" value={conn?.pregel ? "netdt.bgp.pregel" : "missing"} sub="needs a GDS licence in production" tone={conn?.pregel ? "good" : "warn"} />
        </div>
      </div>

      <div className="card">
        <h3>Bootstrap and reset</h3>
        <div className="row">
          <label className="sel-label">campuses<input className="sel" type="number" min={2} max={60} value={campuses} onChange={(e) => setCampuses(+e.target.value)} /></label>
          <label className="sel-label">data centres<input className="sel" type="number" min={2} max={30} value={dcs} onChange={(e) => setDcs(+e.target.value)} /></label>
          <Btn onClick={ingest} busy={busy === "ingest"}>{empty ? "Ingest demo data" : "Reset and re-ingest"}</Btn>
          <Btn outlined onClick={reset} busy={busy === "reset"} disabled={empty}>Reset (empty the demo data)</Btn>
        </div>
        <p className="hint">Seeded generators (topology, ACLs, BGP networks): the same seed gives the same network on every run. Reset only removes nodes labelled <span className="mono">:Net</span> and the <span className="mono">net_*</span> projections.</p>
        {error && <Banner variant="danger">{error}</Banner>}
        {steps.length > 0 && <ul className="hint">{steps.map((s) => <li key={s.label}>{s.label}: <b>{fmt(s.ms)}</b></li>)}</ul>}
      </div>

      {st && (
        <div className="card">
          <h3>What is in the database now</h3>
          <div className="kpis">
            <Stat label="devices" value={st.devices} /><Stat label="interface nodes (in/out)" value={st.ifaces} />
            <Stat label="LINK + FWD relationships" value={st.links + st.fwd} sub={`${st.links} cables · ${st.fwd} in-device forwards`} />
            <Stat label="interfaces with an ACL" value={st.aclIfaces} /><Stat label="ACEs (list model)" value={st.aces} sub={`${st.aceNodes} as ACE nodes (node model)`} />
            <Stat label="BGP routers / sessions" value={`${st.routers} / ${st.sessions}`} /><Stat label="GDS projections" value={st.gdsGraphs.length} sub={st.gdsGraphs.join(", ") || "none"} />
          </div>
          {topo && <p className="hint">Not NAT, not stateful rules, not IPv6. Synthetic data: times depend on your hardware.</p>}
        </div>
      )}
    </div>
  );
}
