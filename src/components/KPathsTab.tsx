import { useState } from "react";
import { useApp, useAction } from "../ctx";
import { flowOf, type Flow } from "../lib/topology";
import { ensureBase, rawYen, pathPermitted, hybrid, plantDeny, clearPlanted, deviceSeq, type PathRes } from "../lib/kpath";
import { runQuery, withGroup } from "../lib/neo4j";
import { TopoGraph, nodeOf, type Mark } from "./Graphs";
import { Btn, Problem, Table, Stat, Note, Code, fmt } from "./ui";
import { PerFlowBench } from "./BenchParts";

const SRC = "camp1-acc2-h0", DST = "camp13-acc4-h0", K = 3;

export default function KPathsTab() {
  const { db, devices, topo, ready, bump } = useApp();
  const { busy, error, run } = useAction();
  const [planted, setPlanted] = useState<string[]>([]);
  const [cmp, setCmp] = useState<{ raw: PathRes[]; permitted: boolean[]; acl: PathRes[]; ms: number } | null>(null);
  const [ports, setPorts] = useState<{ label: string; n: number; best?: number }[] | null>(null);
  const [fail, setFail] = useState<{ what: string; paths: PathRes[]; base: PathRes[] } | null>(null);
  const f = (port: number, dst = DST, src = SRC): Flow => flowOf(devices, src, dst, "tcp", port);

  const plant = () => run("plant", async () => {
    await withGroup("Scenario 2: plant the trap (live ACL edit)", async () => {
      await ensureBase(db); await clearPlanted(db);
      const deep = await rawYen(db, f(7003), K + 8);
      const esc = new Set(deep[K].ifs); const blocked: string[] = [];
      for (const p of deep.slice(0, K)) {
        const cand = p.ifs.filter((x) => x.endsWith(":out") && !esc.has(x) && !x.startsWith(SRC) && !x.startsWith(DST) && !blocked.includes(x));
        if (!cand.length) throw new Error("cannot construct the trap on this topology: path has no private out-interface");
        await plantDeny(db, cand[0], 7003); blocked.push(cand[0]);
      }
      setPlanted(blocked); setCmp(null); bump();
    });
  });

  const compare = () => run("cmp", async () => {
    await withGroup("Scenario 2: post-filter vs ACL-before-Yen", async () => {
      await ensureBase(db);
      const fl = f(7003);
      const raw = await rawYen(db, fl, K);
      const permitted: boolean[] = [];
      for (const p of raw) permitted.push(await pathPermitted(db, fl, p.ifs));
      const t0 = performance.now();
      const h = await hybrid(db, fl, { k: K });
      setCmp({ raw, permitted, acl: h.paths, ms: performance.now() - t0 });
    });
  });

  const samePorts = () => run("ports", async () => {
    await withGroup("Scenario 2: same model, different flows, nothing rebuilt", async () => {
      await ensureBase(db);
      const out: { label: string; n: number; best?: number }[] = [];
      for (const p of [7001, 7003]) { const h = await hybrid(db, f(p), { k: K }); out.push({ label: `${SRC} → ${DST} tcp/${p}`, n: h.paths.length, best: h.paths[0]?.cost }); }
      const leaves = await runQuery<{ dev: string; ports: number[] }>(`MATCH (i:Iface {dir: 'out'}) WHERE i.device STARTS WITH 'dc' AND i.out_dp_lo IS NOT NULL
        RETURN i.device AS dev, [x IN range(0, size(i.out_seqs) - 1) WHERE i.out_actions[x] = 'permit' AND i.out_protos[x] = 'tcp' | i.out_dp_lo[x]] AS ports ORDER BY dev`, {}, { database: db });
      const leaf = leaves.find((l) => l.ports.includes(80) && !l.ports.includes(443));
      if (leaf) for (const p of [80, 443, 22]) { const h = await hybrid(db, f(p, `${leaf.dev}-h0`), { k: K }); out.push({ label: `${SRC} → ${leaf.dev}-h0 tcp/${p}`, n: h.paths.length, best: h.paths[0]?.cost }); }
      setPorts(out);
    });
  });

  const failure = (kind: "device" | "link") => run("fail", async () => {
    await withGroup(`Scenario 2: exclude a failed ${kind} at filter time`, async () => {
      await ensureBase(db);
      const base = (await hybrid(db, f(7001), { k: K })).paths;
      const p1 = base[0];
      if (kind === "device") {
        const mid = deviceSeq(p1.devs)[3];
        const did = devices.find((d) => d.name === mid)!.did;
        const r = await hybrid(db, f(7001), { k: K, xdid: [did] });
        setFail({ what: `device ${mid} failed`, paths: r.paths, base });
      } else {
        const lid = (await runQuery<{ id: number }>("MATCH (a:Iface {name: $n})-[r:LINK]->() RETURN r.id AS id", { n: p1.ifs[2] }, { database: db }))[0].id;
        const r = await hybrid(db, f(7001), { k: K, xlid: [lid] });
        setFail({ what: `link ${lid} (${p1.ifs[2]}) failed`, paths: r.paths, base });
      }
    });
  });

  const clear = () => run("clear", async () => { await clearPlanted(db); setPlanted([]); setCmp(null); setFail(null); bump(); });

  const marks: Mark[] = planted.map((x) => ({ node: nodeOf(x.split(":")[0]), color: "#c62828", label: "deny 7003" }));
  const post = cmp ? cmp.raw.filter((_, i) => cmp.permitted[i]) : [];
  const col = ["#c62828", "#e57373", "#ef9a9a"];

  return (
    <div>
      <Problem kind="kpaths" title="K paths under policy: the post-filter trap" objection="K shortest paths are the K shortest physically. Filtering them afterwards by policy leaves you with nothing.">
        Yen's top-3 can all be denied by an ACL on a transit interface. <b>Post-filtering</b> those 3 returns <b>0 paths</b>, even though a permitted 4th path exists.
        The fix is to evaluate the ACLs <b>before</b> Yen: Cypher computes the denied interfaces for <i>this flow</i>, <code>gds.graph.filter</code> removes them (plus failed
        devices and links) from one shared base projection, and Yen runs on what is left. Two flows on different ports, same model: different answers, nothing rebuilt.
      </Problem>

      <div className="card">
        <h3>1 · Plant the trap (a live ACL edit)</h3>
        <p className="hint">Flow {SRC} → {DST}, tcp/7003, K = {K}. The button reads Yen's top-{K + 1} and writes a deny ACE on one private interface of each of the top-{K} paths, in both storage models.</p>
        <div className="row"><Btn onClick={plant} busy={busy === "plant"} disabled={!ready}>Plant deny tcp/7003 on the top-{K} paths</Btn><Btn outlined onClick={clear} busy={busy === "clear"} disabled={!ready}>Remove every planted ACE</Btn></div>
        {planted.length > 0 && <p className="hint mono">denied at: {planted.join(", ")}</p>}
        {error && <Note tone="danger">{error}</Note>}
      </div>

      <div className="card">
        <h3>2 · Post-filter vs ACL-before-Yen</h3>
        <div className="row"><Btn onClick={compare} busy={busy === "cmp"} disabled={!ready || planted.length === 0}>Run both approaches</Btn></div>
        {cmp && topo && (
          <>
            <div className="twocol">
              <div>
                <h4>Post-filter: Yen top-{K}, then drop the denied</h4>
                <TopoGraph topo={topo} paths={cmp.raw.map((p, i) => ({ devs: p.devs, color: col[i % 3], dashed: true }))} marks={marks} height={300} />
                <div className="kpis"><Stat label="paths returned" value={post.length} tone={post.length ? "good" : "bad"} sub={`${cmp.raw.length} found, ${cmp.permitted.filter((x) => !x).length} denied`} /></div>
              </div>
              <div>
                <h4>ACL first, then Yen</h4>
                <TopoGraph topo={topo} paths={cmp.acl.map((p) => ({ devs: p.devs, color: "#2e7d32" }))} marks={marks} height={300} />
                <div className="kpis"><Stat label="permitted paths returned" value={cmp.acl.length} tone={cmp.acl.length ? "good" : "bad"} sub={`one request: ${fmt(cmp.ms)}`} /></div>
              </div>
            </div>
            <Table head={["#", "cost", "route (devices)"]} rows={cmp.acl.map((p, i) => [i + 1, p.cost, <span className="mono">{deviceSeq(p.devs).join(" → ")}</span>])} />
          </>
        )}
      </div>

      <div className="card">
        <h3>3 · Same model, different flows, nothing rebuilt</h3>
        <div className="row"><Btn onClick={samePorts} busy={busy === "ports"} disabled={!ready}>Run flows on different ports</Btn></div>
        {ports && <Table head={["flow", "permitted paths", "best cost"]} rows={ports.map((p) => [<span className="mono">{p.label}</span>, <span className={p.n ? "good" : "bad"}>{p.n}</span>, p.best ?? "–"])} />}
        <p className="hint">The destination leaf only permits its own services; the guest subnet is blocked at the campus uplinks. The projection is the same object each time.</p>
      </div>

      <div className="card">
        <h3>4 · Failed devices and links, excluded at filter time</h3>
        <div className="row"><Btn onClick={() => failure("device")} busy={busy === "fail"} disabled={!ready}>Fail a transit device on path 1</Btn><Btn outlined onClick={() => failure("link")} busy={busy === "fail"} disabled={!ready}>Fail a link on path 1</Btn></div>
        {fail && (<>
          <p><b>{fail.what}</b>: path 1 was cost {fail.base[0]?.cost}, now {fail.paths[0]?.cost ?? "none"}. {fail.paths.length} paths returned; the model was not modified.</p>
          <Table head={["#", "cost", "route"]} rows={fail.paths.map((p, i) => [i + 1, p.cost, <span className="mono">{deviceSeq(p.devs).join(" → ")}</span>])} />
        </>)}
        <Code>{`CALL gds.graph.filter($g, 'net_base', 'n.nid <> 17 AND n.nid <> 42 AND n.did <> 301', 'r.lid <> 88')
// nid = denied interface nodes (computed by Cypher for this flow), did = failed device, lid = failed link`}</Code>
      </div>

      <PerFlowBench />
      <p className="hint">Yen's K paths are often variations of one path. If you need disjoint paths for resilience, that is a different algorithm. Return traffic is a separate flow (swap source and destination).</p>
    </div>
  );
}
