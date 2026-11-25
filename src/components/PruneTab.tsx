import { useState } from "react";
import { useApp, useAction } from "../ctx";
import { seededFlows, flowOf, type Flow } from "../lib/topology";
import { ensureBase, hybrid, qpp, sameCosts, deviceSeq, type PathRes } from "../lib/kpath";
import { qppQuery } from "../lib/cypher";
import { planOf, flattenPlan, totalDbHits, median, pct, withGroup, type PlanNode } from "../lib/neo4j";
import FlowPicker from "./FlowPicker";
import { Btn, Problem, Table, Stat, Note, Code, Verdict, fmt } from "./ui";

export default function PruneTab() {
  const { db, devices, ready } = useApp();
  const { busy, error, run } = useAction();
  const [flow, setFlow] = useState<Flow>({ src: 0, dst: 0, proto: "tcp", dport: 7001, src_host: "camp1-acc2-h0", dst_host: "camp13-acc4-h0" });
  const [mult, setMult] = useState(1.3);
  const [res, setRes] = useState<{ q: PathRes[]; y: PathRes[]; qms: number; budget: number } | null>(null);
  const [plan, setPlan] = useState<PlanNode | null>(null);
  const [prof, setProf] = useState<{ budget: number; hits: number; rows: number; ms: number }[] | null>(null);
  const [eq, setEq] = useState<{ same: number; n: number; t: number[]; ty: number[]; timeouts: number } | null>(null);
  const f = ready ? flowOf(devices, flow.src_host, flow.dst_host, flow.proto, flow.dport) : flow;

  const best = async () => { await ensureBase(db); const y = (await hybrid(db, f, { k: 5 })).paths; return y; };

  const go = () => run("go", async () => {
    await withGroup("Scenario 3: QPP + allReduce budget vs Yen", async () => {
      const y = await best(); if (!y.length) { setRes({ q: [], y: [], qms: 0, budget: 0 }); return; }
      const budget = y[0].cost * mult;
      const q = await qpp(db, f, budget, 5);
      setRes({ q: q.paths, y: y.filter((p) => p.cost <= budget), qms: q.ms, budget });
    });
  });

  const explain = () => run("explain", async () => {
    await withGroup("Scenario 3: EXPLAIN the pruned expansion", async () => {
      const y = await best(); const budget = (y[0]?.cost ?? 50) * mult;
      setPlan((await planOf("EXPLAIN", qppQuery(true), { flow: f, budget, k: 5 }, { database: db, timeoutMs: 30000 })).plan);
    });
  });

  const profile = () => run("profile", async () => {
    await withGroup("Scenario 3: PROFILE under growing budgets (pruning proof)", async () => {
      const y = await best(); if (!y.length) return;
      const out: { budget: number; hits: number; rows: number; ms: number }[] = [];
      for (const m of [1.0, 1.15, 1.3, 1.6]) {
        const budget = y[0].cost * m;
        const { plan: p, ms } = await planOf("PROFILE", qppQuery(false), { flow: f, budget, k: 5 }, { database: db, timeoutMs: 60000 });
        const rows = flattenPlan(p).reduce((mx, x) => Math.max(mx, x.node.rows ?? 0), 0);
        out.push({ budget, hits: totalDbHits(p), rows, ms }); setProf([...out]);
      }
    });
  });

  const equivalence = () => run("eq", async () => {
    await withGroup("Scenario 3: QPP == Yen on 100 flows (server-side timeout 30 s)", async () => {
      await ensureBase(db);
      const flows = seededFlows(devices, 100);
      let same = 0, timeouts = 0; const t: number[] = [], ty: number[] = [];
      for (const x of flows) {
        const t0 = performance.now(); const y = (await hybrid(db, x, { k: 5 })).paths; ty.push(performance.now() - t0);
        const budget = y.length ? y[0].cost * 1.3 : 100;
        try {
          const q = await qpp(db, x, budget, 5, 30000); t.push(q.ms);
          same += +sameCosts(y.filter((p) => p.cost <= budget), q.paths);
        } catch (e) { if (/timed out|terminated/i.test((e as Error).message)) { timeouts++; t.push(30000); } else throw e; }
      }
      setEq({ same, n: flows.length, t, ty, timeouts });
    });
  });

  const ops = plan ? flattenPlan(plan) : [];
  const pruned = ops.filter((o) => /allReduce/i.test(o.node.details) || /inlined/i.test(o.node.details));

  return (
    <div>
      <Problem kind="prune" title="Policy-aware paths without leaving Cypher" objection="Cypher enumerates every path, then filters. Under a cost budget and an ACL it will never finish.">
        Cypher 25 quantified path patterns put the <b>ACL predicate inside the pattern</b>, and <code>allReduce</code> over the <b>group variable</b> makes a cost budget prune{" "}
        <b>during the expansion</b>, not after. No projection to build, always current. The plan below shows the budget inside the expansion operator, the PROFILE shows work growing
        with the budget (not with the size of the network), and the paths are the same as Yen's.
      </Problem>

      <div className="card">
        <h3>Query</h3>
        <FlowPicker flow={f} onChange={setFlow} />
        <div className="row">
          <label className="sel-label">budget = best cost × {mult.toFixed(2)}<input type="range" min={1} max={2} step={0.05} value={mult} onChange={(e) => setMult(+e.target.value)} /></label>
          <Btn onClick={go} busy={busy === "go"} disabled={!ready}>Run QPP and Yen</Btn><Btn outlined onClick={explain} busy={busy === "explain"} disabled={!ready}>EXPLAIN</Btn><Btn outlined onClick={profile} busy={busy === "profile"} disabled={!ready}>PROFILE 4 budgets</Btn>
        </div>
        <Code>{qppQuery(true).replace(/\(\(\(?[^\n]*\n/, (m) => m).split("\n").map((l) => (l.length > 150 ? l.slice(0, 150) + " …" : l)).join("\n")}</Code>
        {error && <Note tone="danger">{error}</Note>}
      </div>

      {res && (
        <div className="card">
          <h3>Result: budget {res.budget.toFixed(1)}</h3>
          <div className="kpis">
            <Stat label="QPP in Cypher" value={fmt(res.qms)} sub={`${res.q.length} paths`} /><Stat label="Yen (hybrid)" value={`${res.y.length} paths`} />
            <Stat label="same costs as Yen" value={sameCosts(res.y, res.q) ? "yes" : "NO"} tone={sameCosts(res.y, res.q) ? "good" : "bad"} />
          </div>
          <Table head={["#", "QPP cost", "Yen cost", "route"]} rows={res.q.map((p, i) => [i + 1, p.cost, res.y[i]?.cost ?? "–", <span className="mono">{deviceSeq(p.devs).join(" → ")}</span>])} />
          <p className="hint"><b>Do not use <code>SHORTEST k</code></b>: it ranks by number of hops, not by cost, so it does not answer “cheapest paths”.</p>
        </div>
      )}

      {plan && (
        <div className="card">
          <h3>Execution plan: the budget is inside the expansion</h3>
          <Note tone={pruned.length ? "success" : "warning"}>{pruned.length ? `${pruned.length} operator(s) carry the allReduce budget (inlined into the expansion) — pruning happens while paths grow.` : "No inlined allReduce detail found in this plan: inspect the operators below."}</Note>
          <div className="code">{ops.map((o, i) => <div key={i} style={{ paddingLeft: o.depth * 12, color: /allReduce|inlined/i.test(o.node.details) ? "#7ee787" : undefined }}>{o.node.operator}{o.node.details ? `  —  ${o.node.details.slice(0, 220)}` : ""}</div>)}</div>
        </div>
      )}

      {prof && (
        <div className="card">
          <h3>PROFILE: work follows the budget</h3>
          <Table head={["budget", "db hits (all operators)", "max rows in an operator", "time"]} rows={prof.map((p) => [p.budget.toFixed(1), p.hits.toLocaleString(), p.rows.toLocaleString(), fmt(p.ms)])} />
          <p className="hint">Without a cost budget the number of simple paths in a mesh grows combinatorially; here the cost is bounded by what fits under the budget.</p>
        </div>
      )}

      <div className="card">
        <h3>Equivalence check: QPP = Yen</h3>
        <div className="row"><Btn outlined onClick={equivalence} busy={busy === "eq"} disabled={!ready}>Compare on 100 seeded flows</Btn></div>
        {eq && (
          <div className="kpis">
            <Stat label="identical to Yen" value={`${eq.same} / ${eq.n}`} tone={eq.same === eq.n ? "good" : "bad"} sub={eq.timeouts ? `${eq.timeouts} server-side timeouts` : "no timeouts"} />
            <Stat label="QPP median / p95" value={`${fmt(median(eq.t))} / ${fmt(pct(eq.t, 95))}`} /><Stat label="Yen hybrid median / p95" value={`${fmt(median(eq.ty))} / ${fmt(pct(eq.ty, 95))}`} />
          </div>
        )}
        <p className="hint">Recommendation: Yen for K cheapest paths; the Cypher form when a cost budget is known or when the rule needs a running value along the path. QPP cost depends on how many paths fit under the budget, so its tail is longer.</p>
        <Verdict ok={eq ? eq.same === eq.n : null}>{eq ? "checked live" : "not run yet"}</Verdict>
      </div>
    </div>
  );
}
