import { useState } from "react";
import { useApp, useAction } from "../ctx";
import { flowOf } from "../lib/topology";
import { ensureBase, hybrid, perRequest, plantDeny, clearPlanted, projectBase, deviceSeq, type PathRes } from "../lib/kpath";
import { runQuery, withGroup } from "../lib/neo4j";
import { Btn, Problem, Stat, Note, Table, fmt } from "./ui";
import { DensityBench, ConcurrencyBench } from "./BenchParts";

const SRC = "camp1-acc2-h0", DST = "camp13-acc4-h0";

const ADD_LINK = `
MATCH (a1:Device {name: 'camp1-dist2'}), (b1:Device {name: 'camp13-dist2'})
CALL () { MATCH (i:Iface) RETURN max(i.nid) AS m }
CREATE (a1)-[:HAS_IF]->(xo:Net:Iface {name: 'camp1-dist2:ex:out', ifname: 'camp1-dist2:ex', device: 'camp1-dist2', dir: 'out', nid: m + 1, did: a1.did}),
       (a1)-[:HAS_IF]->(xi:Net:Iface {name: 'camp1-dist2:ex:in',  ifname: 'camp1-dist2:ex', device: 'camp1-dist2', dir: 'in',  nid: m + 2, did: a1.did}),
       (b1)-[:HAS_IF]->(yo:Net:Iface {name: 'camp13-dist2:ex:out', ifname: 'camp13-dist2:ex', device: 'camp13-dist2', dir: 'out', nid: m + 3, did: b1.did}),
       (b1)-[:HAS_IF]->(yi:Net:Iface {name: 'camp13-dist2:ex:in',  ifname: 'camp13-dist2:ex', device: 'camp13-dist2', dir: 'in',  nid: m + 4, did: b1.did}),
       (xo)-[:LINK {id: 99999, cost: 1.0}]->(yi), (yo)-[:LINK {id: 99999, cost: 1.0}]->(xi)
WITH a1, b1, xi, xo, yi, yo
CALL (a1, xi, xo) {
  MATCH (a1)-[:HAS_IF]->(p:Iface {dir: 'in'}) WHERE p.ifname <> 'camp1-dist2:ex' CREATE (p)-[:FWD {cost: 1.0}]->(xo)
  WITH a1, xi MATCH (a1)-[:HAS_IF]->(q:Iface {dir: 'out'}) WHERE q.ifname <> 'camp1-dist2:ex' CREATE (xi)-[:FWD {cost: 1.0}]->(q)
  RETURN count(*) AS c1 }
CALL (b1, yi, yo) {
  MATCH (b1)-[:HAS_IF]->(p:Iface {dir: 'in'}) WHERE p.ifname <> 'camp13-dist2:ex' CREATE (p)-[:FWD {cost: 1.0}]->(yo)
  WITH b1, yi MATCH (b1)-[:HAS_IF]->(q:Iface {dir: 'out'}) WHERE q.ifname <> 'camp13-dist2:ex' CREATE (yi)-[:FWD {cost: 1.0}]->(q)
  RETURN count(*) AS c2 }
RETURN c1 + c2 AS fwd`;
const DEL_LINK = "MATCH (i:Iface) WHERE i.ifname IN ['camp1-dist2:ex', 'camp13-dist2:ex'] DETACH DELETE i";

export default function FreshTab() {
  const { db, devices, ready, bump } = useApp();
  const { busy, error, run } = useAction();
  const f = (port: number) => flowOf(devices, SRC, DST, "tcp", port);
  const [acl, setAcl] = useState<{ before: PathRes; after?: PathRes; blocked?: string; ms?: number } | null>(null);
  const [topo, setTopo] = useState<{ before?: number; perReq?: number; stale?: number; fresh?: number; refresh?: number; added: boolean } | null>(null);

  const aclChange = () => run("acl", async () => {
    await withGroup("Scenario 4: change an ACL, see it immediately", async () => {
      await ensureBase(db); await clearPlanted(db);
      const before = (await hybrid(db, f(7005), { k: 1 })).paths[0];
      const victim = before.ifs.filter((x) => x.endsWith(":out") && !x.startsWith(SRC) && !x.startsWith(DST))[1];
      await plantDeny(db, victim, 7005);
      const t0 = performance.now();
      const after = (await hybrid(db, f(7005), { k: 1 })).paths[0];
      setAcl({ before, after, blocked: victim, ms: performance.now() - t0 }); bump();
    });
  });
  const undoAcl = () => run("undo", async () => { await clearPlanted(db); setAcl(null); bump(); });

  const addLink = () => run("link", async () => {
    await withGroup("Scenario 4: add a link, the base projection goes stale", async () => {
      await ensureBase(db); await runQuery(DEL_LINK, {}, { database: db });
      const before = (await hybrid(db, f(7001), { k: 1 })).paths[0]?.cost;
      await runQuery(ADD_LINK, {}, { database: db });
      const perReq = (await perRequest(db, f(7001), { k: 1 })).paths[0]?.cost;
      const stale = (await hybrid(db, f(7001), { k: 1 })).paths[0]?.cost;
      setTopo({ before, perReq, stale, added: true }); bump();
    });
  });
  const refresh = () => run("refresh", async () => {
    await withGroup("Scenario 4: refresh the base projection", async () => {
      const r = await projectBase(db);
      const fresh = (await hybrid(db, f(7001), { k: 1 })).paths[0]?.cost;
      setTopo((t) => ({ ...(t ?? { added: true }), fresh, refresh: r.ms }));
    });
  });
  const removeLink = () => run("rm", async () => { await runQuery(DEL_LINK, {}, { database: db }); await projectBase(db); setTopo(null); bump(); });

  return (
    <div>
      <Problem kind="fresh" title="Fresh policy, at scale" objection="A graph engine works on a loaded snapshot. After a change, results are stale; with real ACL volumes it does not hold.">
        Two kinds of change behave differently, and we show both honestly. An <b>ACL change</b> is visible on the very next request, because ACLs are read from the database for every flow.
        A <b>topology change</b> (a new link) is visible immediately to a per-request projection, but the shared base projection must be refreshed: a one-off cost, measured below.
        Then the scale: ACL density up to ~300k entries in the worst case, and concurrent clients, both measured live.
      </Problem>

      <div className="card">
        <h3>A · Change an ACL</h3>
        <div className="row"><Btn onClick={aclChange} busy={busy === "acl"} disabled={!ready}>Deny tcp/7005 on a transit interface of the best path</Btn><Btn outlined onClick={undoAcl} busy={busy === "undo"} disabled={!ready}>Undo</Btn></div>
        {acl && (<>
          <div className="kpis"><Stat label="best path before" value={acl.before.cost} /><Stat label="best path after" value={acl.after?.cost ?? "none"} tone="good" sub={`next request: ${fmt(acl.ms ?? 0)}, base projection untouched`} /></div>
          <p className="hint mono">denied: {acl.blocked}<br />before: {deviceSeq(acl.before.devs).join(" → ")}<br />after: {acl.after ? deviceSeq(acl.after.devs).join(" → ") : "–"}</p>
        </>)}
      </div>

      <div className="card">
        <h3>B · Change the topology</h3>
        <div className="row"><Btn onClick={addLink} busy={busy === "link"} disabled={!ready}>Add a direct link camp1-dist2 ↔ camp13-dist2 (cost 1)</Btn><Btn outlined onClick={refresh} busy={busy === "refresh"} disabled={!topo}>Refresh the base projection</Btn><Btn outlined onClick={removeLink} busy={busy === "rm"} disabled={!ready}>Remove the link</Btn></div>
        {topo && (
          <Table head={["", "best cost for tcp/7001", ""]} rows={[
            ["before the change", topo.before ?? "–", ""],
            ["per-request projection (a)", topo.perReq ?? "–", <span className="good">sees the new link at once</span>],
            ["base projection + filter (b), not refreshed", topo.stale ?? "–", topo.stale === topo.before ? <span className="bad">stale: the base graph predates the link</span> : ""],
            ["(b) after refresh", topo.fresh ?? "–", topo.refresh !== undefined ? <span className="good">refresh took {fmt(topo.refresh)}</span> : "press refresh"],
          ]} />
        )}
        {error && <Note tone="danger">{error}</Note>}
        <p className="hint">Choose per use case: (a) when topology changes constantly, (b) when it changes rarely and per-flow latency matters. Policy changes never need a refresh.</p>
      </div>

      <DensityBench />
      <ConcurrencyBench />
    </div>
  );
}
