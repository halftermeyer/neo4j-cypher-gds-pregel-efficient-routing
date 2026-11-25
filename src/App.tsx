import { useEffect, useState } from "react";
import { Tabs } from "@neo4j-ndl/react";
import { AppProvider, useApp } from "./ctx";
import { MAIN_DB, runQuery } from "./lib/neo4j";
import { generateTopology } from "./lib/topology";
import QueryAuditDrawer from "./components/QueryAuditDrawer";
import Setup from "./components/Setup";
import AclTab from "./components/AclTab";
import KPathsTab from "./components/KPathsTab";
import PruneTab from "./components/PruneTab";
import FreshTab from "./components/FreshTab";
import VrfTab from "./components/VrfTab";
import BgpTab from "./components/BgpTab";
import BatfishTab from "./components/BatfishTab";
import BenchTab from "./components/BenchTab";

const TABS: [string, string][] = [
  ["setup", "Setup"], ["acl", "1 · ACL model"], ["kpaths", "2 · K permitted paths"], ["prune", "3 · Pruning in Cypher"],
  ["fresh", "4 · Freshness & scale"], ["vrf", "5 · VRF"], ["bgp", "6 · BGP"], ["batfish", "7 · Fidelity (Batfish)"], ["bench", "Benchmark"],
];

function Shell() {
  const [tab, setTab] = useState("setup");
  const { setTopo } = useApp();
  // If the database was already ingested (page reload), rebuild the deterministic generator output in memory.
  useEffect(() => {
    runQuery<{ seed: number; campuses: number; dcs: number }>("MATCH (m:Meta) RETURN m.seed AS seed, m.campuses AS campuses, m.dcs AS dcs LIMIT 1", {}, { silent: true })
      .then((r) => { if (r[0]) setTopo(generateTopology({ seed: r[0].seed, campuses: r[0].campuses, dcs: r[0].dcs })); })
      .catch(() => undefined);
  }, [setTopo]);
  return (
    <div className="app-container">
      <header className="app-header">
        <div className="header-content">
          <h1><span className="header-icon">&#128752;</span> Network digital twin: policy-aware routing in Neo4j</h1>
          <p className="subtitle">An international bank compares graph engines. Each tab answers one objection live: ACL-aware K paths, pruning in Cypher, VRF, BGP convergence with Cypher and GDS Pregel.</p>
        </div>
      </header>
      <div className="app-tabs">
        <Tabs fill="underline" onChange={setTab} value={tab}>
          {TABS.map(([id, label]) => <Tabs.Tab key={id} id={id}>{label}</Tabs.Tab>)}
        </Tabs>
      </div>
      <main className="app-main">
        {tab === "setup" && <Setup />}
        {tab === "acl" && <AclTab />}
        {tab === "kpaths" && <KPathsTab />}
        {tab === "prune" && <PruneTab />}
        {tab === "fresh" && <FreshTab />}
        {tab === "vrf" && <VrfTab />}
        {tab === "bgp" && <BgpTab />}
        {tab === "batfish" && <BatfishTab />}
        {tab === "bench" && <BenchTab />}
      </main>
      <QueryAuditDrawer />
    </div>
  );
}

export default function App() {
  return <AppProvider db={MAIN_DB}><Shell /></AppProvider>;
}
