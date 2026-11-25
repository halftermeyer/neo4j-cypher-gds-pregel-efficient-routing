import { useState } from "react";
import { useApp, useAction } from "../ctx";
import { flowOf, seededFlows, ipStr, type Flow } from "../lib/topology";
import { ensureBase, rawYen, hopDecisions, decide, hopAgree, hopPermit, blockedSet, hybrid, deviceSeq, type Hop, type PathRes } from "../lib/kpath";
import { median, pct, withGroup } from "../lib/neo4j";
import FlowPicker, { presetsOf } from "./FlowPicker";
import { Btn, Problem, Table, Verdict, Stat, Note, fmt } from "./ui";

export default function AclTab() {
  const { db, devices, ready, topo } = useApp();
  const [flow, setFlow] = useState<Flow>(() => ({ src: 0, dst: 0, proto: "tcp", dport: 443, src_host: "camp1-acc2-h0", dst_host: "dc3-leaf1-h0" }));
  const [raw, setRaw] = useState<{ path: PathRes; hops: Hop[] } | null>(null);
  const [alt, setAlt] = useState<{ path: PathRes; hops: Hop[] } | null>(null);
  const [eq, setEq] = useState<{ same: number; n: number; tl: number[]; tn: number[] } | null>(null);
  const { busy, error, run } = useAction();

  const [inited, setInited] = useState(false);
  if (ready && !inited) { setInited(true); const p = presetsOf(topo)[0]; setFlow(flowOf(devices, p.src, p.dst, p.proto, p.port)); }
  const f = ready ? flowOf(devices, flow.src_host, flow.dst_host, flow.proto, flow.dport) : flow;

  const evaluate = () => run("eval", async () => {
    await withGroup("Scenario 1: decide a flow hop by hop", async () => {
      await ensureBase(db);
      const [p] = await rawYen(db, f, 1);
      if (!p) { setRaw(null); setAlt(null); return; }
      setRaw({ path: p, hops: await hopDecisions(db, f, p.ifs) });
      const h = await hybrid(db, f, { k: 1 });
      setAlt(h.paths[0] ? { path: h.paths[0], hops: await hopDecisions(db, f, h.paths[0].ifs) } : null);
    });
  });

  const equivalence = () => run("eq", async () => {
    await withGroup("Scenario 1: list model vs node model on 100 flows", async () => {
      const flows = seededFlows(devices, 100);
      let same = 0; const tl: number[] = [], tn: number[] = [];
      for (const x of flows) {
        let t = performance.now(); const a = await blockedSet(db, x, "list"); tl.push(performance.now() - t);
        t = performance.now(); const b = await blockedSet(db, x, "node"); tn.push(performance.now() - t);
        same += +(a.slice().sort((p, q) => p - q).join() === b.slice().sort((p, q) => p - q).join());
      }
      setEq({ same, n: flows.length, tl, tn });
    });
  });

  const table = (r: { path: PathRes; hops: Hop[] }) => (
    <Table
      head={["#", "device", "in-ACL: list model", "in-ACL: ACE nodes", "out-ACL: list model", "out-ACL: ACE nodes", "hop", "models agree"]}
      rows={r.hops.map((h, i) => {
        const a = decide(h.inHasAcl, h.inList), b = decide(h.inHasAcl, h.inNode), c = decide(h.outHasAcl, h.outList), d = decide(h.outHasAcl, h.outNode);
        const col = (x: { permit: boolean; text: string }) => <span className={x.permit ? "good" : "bad"}>{x.text}</span>;
        return [i + 1, <span className="mono">{h.device}</span>, col(a), col(b), col(c), col(d), <Verdict ok={hopPermit(h)}>{hopPermit(h) ? "permit" : "deny"}</Verdict>, <Verdict ok={hopAgree(h)}>{hopAgree(h) ? "same" : "DIFFERENT"}</Verdict>];
      })}
    />
  );
  const denied = raw?.hops.filter((h) => !hopPermit(h)).length ?? 0;
  const allAgree = [raw, alt].every((x) => !x || x.hops.every(hopAgree));

  return (
    <div>
      <Problem kind="acl" title="Can the graph model really honour ACLs?" objection="Policies live in the devices; a graph only knows topology, so its paths ignore the firewall rules.">
        Each interface is split into an <b>in</b> node and an <b>out</b> node: crossing a device means in → out, so a packet is checked against both ACLs.
        ACEs are stored two ways, as ordered lists on the interface and as ACE nodes; IPv4 ranges are integers; <b>first match by sequence wins</b>, then an implicit deny;
        an interface without ACL permits. Pick a flow and watch which ACE decides at every hop.
      </Problem>

      <div className="card">
        <h3>Flow</h3>
        <FlowPicker flow={f} onChange={setFlow} />
        <p className="hint mono">src {ipStr(f.src)} → dst {ipStr(f.dst)} · {f.proto}/{f.dport}</p>
        <div className="row"><Btn onClick={evaluate} busy={busy === "eval"} disabled={!ready}>Evaluate the flow</Btn>{!ready && <span className="hint">ingest the data on the Setup tab first</span>}</div>
        {error && <Note tone="danger">{error}</Note>}
      </div>

      {raw && (
        <div className="card">
          <h3>Physical shortest path (policy ignored): {deviceSeq(raw.path.devs).length} devices, cost {raw.path.cost}</h3>
          <p className="hint mono">{deviceSeq(raw.path.devs).join(" → ")}</p>
          {table(raw)}
          <Note tone={denied ? "danger" : "success"}>{denied ? `${denied} hop(s) deny this flow: the physically shortest path is not usable.` : "Every hop permits the flow."}</Note>
        </div>
      )}
      {raw && denied > 0 && (
        <div className="card">
          <h3>{alt ? `Cheapest permitted path: cost ${alt.path.cost}` : "No permitted path for this flow"}</h3>
          {alt ? (<><p className="hint mono">{deviceSeq(alt.path.devs).join(" → ")}</p>{table(alt)}</>) : <p>The flow is denied everywhere it could go. That is a valid answer.</p>}
        </div>
      )}
      {(raw || alt) && <Note tone={allAgree ? "success" : "danger"}>{allAgree ? "Both storage models decide identically at every hop shown." : "The models disagree somewhere."}</Note>}

      <div className="card">
        <h3>Equivalence check: both models give the same answer</h3>
        <div className="row"><Btn outlined onClick={equivalence} busy={busy === "eq"} disabled={!ready}>Compare both models on 100 seeded flows</Btn></div>
        {eq && (
          <div className="kpis">
            <Stat label="identical blocked-interface sets" value={`${eq.same} / ${eq.n}`} tone={eq.same === eq.n ? "good" : "bad"} />
            <Stat label="list model, median / p95" value={`${fmt(median(eq.tl))} / ${fmt(pct(eq.tl, 95))}`} />
            <Stat label="ACE nodes, median / p95" value={`${fmt(median(eq.tn))} / ${fmt(pct(eq.tn, 95))}`} />
          </div>
        )}
      </div>
    </div>
  );
}
