import { useState } from "react";
import { useApp, useAction } from "../ctx";
import { flowOf } from "../lib/topology";
import { ensureBase, hybrid, deviceSeq } from "../lib/kpath";
import { runQuery, withGroup } from "../lib/neo4j";
import { Btn, Problem, Table, Verdict, Note } from "./ui";

const SRC = "camp1-acc2-h0";
const CASES: { label: string; dst: string; vrf: string; expect: boolean; leak?: boolean }[] = [
  { label: "RED flow → dc2 (RED)", dst: "dc2-leaf1-h0", vrf: "RED", expect: true },
  { label: "BLUE flow → dc2 (RED)", dst: "dc2-leaf1-h0", vrf: "BLUE", expect: false },
  { label: "RED flow → dc3 (BLUE)", dst: "dc3-leaf1-h0", vrf: "RED", expect: false },
  { label: "BLUE flow → dc3 (BLUE)", dst: "dc3-leaf1-h0", vrf: "BLUE", expect: true },
];

export default function VrfTab() {
  const { db, devices, ready, bump } = useApp();
  const { busy, error, run } = useAction();
  const [assigned, setAssigned] = useState(false);
  const [leaked, setLeaked] = useState(false);
  const [rows, setRows] = useState<{ label: string; n: number; cost?: number; route: string; ok: boolean }[]>([]);

  const assign = () => run("assign", async () => {
    await withGroup("Scenario 5: assign VRFs (even data centres RED, odd BLUE)", async () => {
      await runQuery(`MATCH (d:Device) WHERE d.site STARTS WITH 'dc' WITH d, toInteger(substring(d.site, 2)) AS n
        MATCH (d)-[:HAS_IF]->(i:Iface) SET i.vrf = CASE WHEN n % 2 = 0 THEN 'RED' ELSE 'BLUE' END, i.vrf_leak = null`, {}, { database: db });
      setAssigned(true); setLeaked(false); setRows([]); bump();
    });
  });
  const leak = () => run("leak", async () => {
    await withGroup("Scenario 5: declare a route leak RED → dc3", async () => {
      await runQuery("MATCH (i:Iface) WHERE i.device STARTS WITH 'dc3-' SET i.vrf_leak = ['RED']", {}, { database: db });
      setLeaked(true);
    });
  });
  const clear = () => run("clear", async () => {
    await runQuery("MATCH (i:Iface) WHERE i.vrf IS NOT NULL OR i.vrf_leak IS NOT NULL REMOVE i.vrf, i.vrf_leak", {}, { database: db });
    setAssigned(false); setLeaked(false); setRows([]); bump();
  });

  const check = () => run("check", async () => {
    await withGroup("Scenario 5: flows through the same model, one VRF attribute each", async () => {
      await ensureBase(db);
      const vrfOf = new Map((await runQuery<{ d: string; v: string }>("MATCH (i:Iface) WHERE i.vrf IS NOT NULL RETURN DISTINCT i.device AS d, i.vrf AS v", {}, { database: db })).map((r) => [r.d, r.v]));
      const cases = leaked ? CASES.map((c) => (c.label.startsWith("RED flow → dc3") ? { ...c, label: "RED flow → dc3 (BLUE), after the declared leak", expect: true, leak: true } : c)) : CASES;
      const out: typeof rows = [];
      for (const c of cases) {
        const r = (await hybrid(db, flowOf(devices, SRC, c.dst, "icmp", 0, c.vrf), { k: 3 })).paths;
        const crossed = new Set(r.flatMap((p) => deviceSeq(p.devs)).filter((d) => vrfOf.get(d) && vrfOf.get(d) !== c.vrf));
        const ok = r.length > 0 === c.expect && (c.leak || crossed.size === 0);
        out.push({ label: c.label, n: r.length, cost: r[0]?.cost, route: crossed.size ? `foreign VRF crossed: ${[...crossed].join(", ")}` : "no foreign-VRF device crossed", ok });
      }
      setRows(out);
    });
  });

  return (
    <div>
      <Problem kind="vrf" title="Isolation and route leaking on the same model" objection="Multi-tenant networks need separate routing tables. A single graph mixes everything.">
        A VRF constraint is <b>one more per-flow filter</b>: interfaces carry a VRF, the flow carries a VRF, and an optional list declares accepted leaks. Interfaces of another VRF are
        removed from the filtered graph together with the ACL-denied ones. Nothing is duplicated and nothing is rebuilt. Simplified on purpose: this is not route distinguishers, route targets or MPLS.
      </Problem>
      <div className="card">
        <h3>Run it</h3>
        <div className="row">
          <Btn onClick={assign} busy={busy === "assign"} disabled={!ready}>1 · Assign VRFs to the data centres</Btn>
          <Btn onClick={check} busy={busy === "check"} disabled={!assigned}>2 · Run the flows</Btn>
          <Btn outlined onClick={leak} busy={busy === "leak"} disabled={!assigned}>3 · Declare a leak RED → dc3</Btn>
          <Btn outlined onClick={clear} busy={busy === "clear"} disabled={!ready}>Remove VRFs</Btn>
        </div>
        <p className="hint">Campus and core stay in the global table. After step 3, run the flows again.</p>
        {error && <Note tone="danger">{error}</Note>}
        {rows.length > 0 && <Table head={["flow", "paths", "best cost", "isolation", "expected"]} rows={rows.map((r) => [r.label, r.n, r.cost ?? "–", r.route, <Verdict ok={r.ok}>{r.ok ? "as expected" : "UNEXPECTED"}</Verdict>])} />}
      </div>
    </div>
  );
}
