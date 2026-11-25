// Benchmarks. They run in an ISOLATED database (netdt-bench) with server-side timeouts, never in the demo database.
// Every number shown is measured now, on this instance, and is displayed with the size of the instance.
import { useState, useSyncExternalStore } from "react";
import { useAction } from "../ctx";
import { BENCH_DB, defaults, median, pct, runQuery, withGroup } from "../lib/neo4j";
import { ensureDatabase, ingestBgp, ingestTopology, resetDemo, stats, type DbStats } from "../lib/db";
import { generateTopology, seededFlows, type Topology } from "../lib/topology";
import { hybrid, perRequest, projectBase, pool, sameCosts, type PathRes } from "../lib/kpath";
import { findNet, ribEqual, simulate } from "../lib/bgp";
import { cypherLoop, pregel } from "../lib/bgprun";
import { Btn, Note, Stat, Table, fmt } from "./ui";

const BASE = "bench_base";
const TIMEOUT = 60000; // ms, server side

// ── tiny shared store: one bench database for all benchmark panels ──
let topo: Topology | null = null;
let st: DbStats | null = null;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const snap = () => st;
export function useBench() {
  const s = useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, snap);
  return { topo, st: s };
}
export async function provision(): Promise<Topology> {
  await withGroup("Benchmark: provision isolated database", async () => {
    await ensureDatabase(BENCH_DB);
    await resetDemo(BENCH_DB);
    topo = generateTopology();
    await ingestTopology(BENCH_DB, topo);
    await projectBase(BENCH_DB, BASE);
    st = await stats(BENCH_DB);
    emit();
  });
  return topo!;
}
/** Per-flow and concurrency runs start from the as-generated model: a density run leaves the bench database inflated, so re-provision. */
async function need(): Promise<Topology> { return topo && st && st.aces < 5000 ? topo : provision(); }
async function withTimeout<T>(fn: () => Promise<T>): Promise<T> { defaults.timeoutMs = TIMEOUT; try { return await fn(); } finally { defaults.timeoutMs = undefined; } }

function Size() {
  const { st } = useBench();
  if (!st) return <p className="hint">Instance: not provisioned yet (the first run provisions the isolated database “{BENCH_DB}”).</p>;
  return <p className="hint">Instance (<b>{BENCH_DB}</b>): {(st.devices + st.ifaces + st.aceNodes).toLocaleString()} nodes, {(st.links + st.fwd).toLocaleString()} traversable relationships, {st.aclIfaces} interfaces with an ACL, <b>{st.aces.toLocaleString()} ACEs</b>. Server-side timeout {TIMEOUT / 1000} s per query.</p>;
}

export function ProvisionBar() {
  const { busy, error, run } = useAction();
  return (
    <div className="row">
      <Btn outlined onClick={() => run("p", async () => { await provision(); })} busy={!!busy}>Reset the benchmark database</Btn>
      {error && <Note tone="danger">{error}</Note>}
    </div>
  );
}

// ───────────────────────── per-flow ─────────────────────────
export function PerFlowBench() {
  const { busy, error, run } = useAction();
  const [n, setN] = useState(100); const [k, setK] = useState(5);
  const [r, setR] = useState<null | { n: number; h: number[]; a: number[]; ph: Record<string, number[]>; same: number }>(null);
  const go = () => run("go", async () => {
    const t = await need();
    await withTimeout(() => withGroup(`Benchmark: per-flow median/p95 over ${n} flows, K=${k}`, async () => {
      const flows = seededFlows(t.devices, n);
      for (const f of flows.slice(0, 3)) { await hybrid(BENCH_DB, f, { k, base: BASE, silent: true }); await perRequest(BENCH_DB, f, { k, silent: true }); }
      const h: number[] = [], a: number[] = [], ph: Record<string, number[]> = { blocked: [], filter: [], yen: [], drop: [] }; let same = 0;
      for (const f of flows) {
        const x = await hybrid(BENCH_DB, f, { k, base: BASE, silent: true }); const y = await perRequest(BENCH_DB, f, { k, silent: true });
        h.push(x.t.total); a.push(y.t.total);
        for (const key of Object.keys(ph)) ph[key].push((x.t as unknown as Record<string, number>)[key]);
        same += +sameCosts(x.paths as PathRes[], y.paths as PathRes[]);
      }
      setR({ n, h, a, ph, same });
    }));
  });
  return (
    <div className="card">
      <h3>Benchmark · per-flow latency (median / p95)</h3>
      <div className="row">
        <label className="sel-label">flows<input className="sel" type="number" style={{ width: 80 }} value={n} min={10} max={500} onChange={(e) => setN(+e.target.value)} /></label>
        <label className="sel-label">K<input className="sel" type="number" style={{ width: 60 }} value={k} min={1} max={10} onChange={(e) => setK(+e.target.value)} /></label>
        <Btn onClick={go} busy={busy === "go"}>Run on {n} seeded flows</Btn>
      </div>
      <Size />
      {error && <Note tone="danger">{error}</Note>}
      {r && (<>
        <div className="kpis">
          <Stat label="(b) base projection + filter" value={`${fmt(median(r.h))} / ${fmt(pct(r.h, 95))}`} tone="good" sub={`${r.n} flows, K=${k}`} />
          <Stat label="(a) projection per request" value={`${fmt(median(r.a))} / ${fmt(pct(r.a, 95))}`} />
          <Stat label="identical results" value={`${r.same} / ${r.n}`} tone={r.same === r.n ? "good" : "bad"} />
        </div>
        <Table head={["(b) phase", "median", "p95"]} rows={Object.entries(r.ph).map(([key, v]) => [({ blocked: "ACL evaluation (Cypher)", filter: "gds.graph.filter", yen: "Yen", drop: "cleanup" } as Record<string, string>)[key], fmt(median(v)), fmt(pct(v, 95))])} />
      </>)}
    </div>
  );
}

// ───────────────────────── ACL density ─────────────────────────
const INFLATE = `
MATCH (i:Iface)
CALL (i) {
  WITH i, i.dir + '_' AS p
  WITH i, p, [k IN range(1, $n) | -k] AS seq, [k IN range(1, $n) | 'deny'] AS act, [k IN range(1, $n) | 'tcp'] AS pr,
       [k IN range(1, $n) | $base + k] AS ip, [k IN range(1, $n) | 1000] AS port, (i[p + 'seqs'] IS NULL) AS fresh
  SET i[p + 'seqs']    = seq  + CASE WHEN fresh THEN [1000]       ELSE i[p + 'seqs']    END,
      i[p + 'actions'] = act  + CASE WHEN fresh THEN ['permit']   ELSE i[p + 'actions'] END,
      i[p + 'protos']  = pr   + CASE WHEN fresh THEN ['ip']       ELSE i[p + 'protos']  END,
      i[p + 'src_lo']  = ip   + CASE WHEN fresh THEN [0]          ELSE i[p + 'src_lo']  END,
      i[p + 'src_hi']  = ip   + CASE WHEN fresh THEN [4294967295] ELSE i[p + 'src_hi']  END,
      i[p + 'dst_lo']  = ip   + CASE WHEN fresh THEN [0]          ELSE i[p + 'dst_lo']  END,
      i[p + 'dst_hi']  = ip   + CASE WHEN fresh THEN [4294967295] ELSE i[p + 'dst_hi']  END,
      i[p + 'dp_lo']   = port + CASE WHEN fresh THEN [0]          ELSE i[p + 'dp_lo']   END,
      i[p + 'dp_hi']   = port + CASE WHEN fresh THEN [65535]      ELSE i[p + 'dp_hi']   END
} IN TRANSACTIONS OF 100 ROWS`;

export function DensityBench() {
  const { busy, error, run } = useAction();
  const [rows, setRows] = useState<{ aces: number; h: number[]; a: number[]; same: number; n: number }[]>([]);
  const [flowsN, setFlowsN] = useState(30);
  const go = () => run("go", async () => {
    await provision();
    const t = topo!;
    await withTimeout(() => withGroup("Benchmark: ACL density, never-matching entries first (worst case)", async () => {
      const flows = seededFlows(t.devices, flowsN);
      const out: typeof rows = []; let baseline: PathRes[][] = [];
      for (const target of [0, 35000, 300000]) {
        if (target) {
          const s = await stats(BENCH_DB);
          const per = Math.max(1, Math.ceil((target - s.aces) / s.ifaces));
          await runQuery(INFLATE, { n: per, base: 3232235776 /* 192.168.0.0 */ }, { database: BENCH_DB, timeoutMs: 600000 });
        }
        st = await stats(BENCH_DB); emit();
        const h: number[] = [], a: number[] = []; let same = 0; const results: PathRes[][] = [];
        await hybrid(BENCH_DB, flows[0], { k: 5, base: BASE, silent: true });
        for (let i = 0; i < flows.length; i++) {
          const x = await hybrid(BENCH_DB, flows[i], { k: 5, base: BASE, silent: true }); const y = await perRequest(BENCH_DB, flows[i], { k: 5, silent: true });
          h.push(x.t.total); a.push(y.t.total); results.push(x.paths);
          same += baseline.length ? +(sameCosts(x.paths, baseline[i]) && sameCosts(y.paths, baseline[i])) : +sameCosts(x.paths, y.paths);
        }
        if (!baseline.length) baseline = results;
        out.push({ aces: st!.aces, h, a, same, n: flows.length }); setRows([...out]);
      }
    }));
  });
  return (
    <div className="card">
      <h3>Benchmark · ACL density (worst case: never-matching entries first)</h3>
      <div className="row">
        <label className="sel-label">flows per level<input className="sel" type="number" style={{ width: 80 }} value={flowsN} min={5} max={100} onChange={(e) => setFlowsN(+e.target.value)} /></label>
        <Btn onClick={go} busy={busy === "go"}>Run: as generated → 35k → 300k ACEs</Btn>
      </div>
      <p className="hint">Each level prepends never-matching ACEs to every interface, so every entry is scanned before the real one. Results must stay identical to the first level.</p>
      <Size />
      {error && <Note tone="danger">{error}</Note>}
      {rows.length > 0 && <Table head={["ACL entries in the model", "(a) projection per request: median / p95", "(b) base + filter: median / p95", "identical results"]}
        rows={rows.map((r) => [r.aces.toLocaleString(), `${fmt(median(r.a))} / ${fmt(pct(r.a, 95))}`, <b>{`${fmt(median(r.h))} / ${fmt(pct(r.h, 95))}`}</b>, <span className={r.same === r.n ? "good" : "bad"}>{r.same} / {r.n}</span>])} />}
    </div>
  );
}

// ───────────────────────── concurrency ─────────────────────────
export function ConcurrencyBench() {
  const { busy, error, run } = useAction();
  const [rows, setRows] = useState<{ mode: string; w: number; wall: number; n: number; errs: number; same: number; lat: number[] }[]>([]);
  const go = () => run("go", async () => {
    const t = await need();
    await withTimeout(() => withGroup("Benchmark: concurrency (parallel clients)", async () => {
      const flows = seededFlows(t.devices, 100);
      const out: typeof rows = [];
      for (const mode of ["(b) base + filter", "(a) projection per request"] as const) {
        let seq: PathRes[][] = [];
        for (const w of [1, 4, 8, 16]) {
          let errs = 0; const lat: number[] = [];
          const t0 = performance.now();
          const res = await pool(flows, w, async (f) => {
            const s0 = performance.now();
            try {
              const r = mode.startsWith("(b)") ? await hybrid(BENCH_DB, f, { k: 5, base: BASE, silent: true }) : await perRequest(BENCH_DB, f, { k: 5, silent: true });
              lat.push(performance.now() - s0); return r.paths;
            } catch { errs++; return null; }
          });
          const wall = performance.now() - t0;
          if (w === 1) seq = res.map((x) => x ?? []);
          const same = res.filter((x, i) => x && sameCosts(x, seq[i])).length;
          out.push({ mode, w, wall, n: flows.length, errs, same, lat }); setRows([...out]);
        }
      }
    }));
  });
  return (
    <div className="card">
      <h3>Benchmark · concurrency (1 to 16 parallel clients)</h3>
      <div className="row"><Btn onClick={go} busy={busy === "go"}>Run 100 flows at 1, 4, 8 and 16 clients</Btn></div>
      <p className="hint">Unlicensed GDS caps algorithm concurrency at 4 per call; here the parallelism is between clients, each running its own filtered graph. Results must equal the sequential run, with no errors.</p>
      <Size />
      {error && <Note tone="danger">{error}</Note>}
      {rows.length > 0 && <Table head={["method", "clients", "flows / second", "latency median / p95", "errors", "identical to sequential"]}
        rows={rows.map((r) => [r.mode, r.w, <b>{(r.n / (r.wall / 1000)).toFixed(0)}</b>, `${fmt(median(r.lat))} / ${fmt(pct(r.lat, 95))}`, r.errs, <span className={r.same === r.n ? "good" : "bad"}>{r.same} / {r.n}</span>])} />}
    </div>
  );
}

// ───────────────────────── Cypher loop vs Pregel ─────────────────────────
const SIZES = [
  { label: "small", nAs: 5, per: [2, 4] as [number, number], nPrefix: 6 },
  { label: "medium", nAs: 10, per: [3, 6] as [number, number], nPrefix: 20 },
  { label: "large", nAs: 20, per: [4, 8] as [number, number], nPrefix: 50 },
  { label: "x-large", nAs: 30, per: [5, 10] as [number, number], nPrefix: 100 },
];
export function LoopVsPregelBench() {
  const { busy, error, run } = useAction();
  const [maxLevel, setMaxLevel] = useState(2);
  const [rows, setRows] = useState<{ label: string; routers: number; routes: number; ref: number; loop: number; peg: number; rounds: number; same: boolean }[]>([]);
  const go = () => run("go", async () => {
    await ensureDatabase(BENCH_DB);
    await withTimeout(() => withGroup("Benchmark: Cypher loop vs GDS Pregel on growing networks", async () => {
      const out: typeof rows = [];
      for (const sz of SIZES.slice(0, maxLevel + 1)) {
        const { net } = findNet({ seed: 100, converges: true, nAs: sz.nAs, perAs: sz.per, nPrefix: sz.nPrefix, pRm: 0.2 });
        await ingestBgp(BENCH_DB, net);
        const t0 = performance.now(); const ref = simulate(net); const tr = performance.now() - t0;
        const loop = await cypherLoop(BENCH_DB, 40, { timeoutMs: 300000 });
        await pregel(BENCH_DB, 40, 4); // warm-up
        const pg = await pregel(BENCH_DB, 40, 4);
        out.push({ label: sz.label, routers: Object.keys(net.R).length, routes: ref.rib.size, ref: tr, loop: loop.ms, peg: pg.ms, rounds: ref.rounds, same: ribEqual(ref.rib, loop.rib) && ribEqual(ref.rib, pg.rib) });
        setRows([...out]);
      }
    }));
  });
  return (
    <div className="card">
      <h3>Benchmark · Cypher fixed-point loop vs GDS Pregel</h3>
      <div className="row">
        <label className="sel-label">largest network<select className="sel" value={maxLevel} onChange={(e) => setMaxLevel(+e.target.value)}>{SIZES.map((s, i) => <option key={s.label} value={i}>{s.label} (≈{Math.round((s.nAs * (s.per[0] + s.per[1])) / 2)} routers)</option>)}</select></label>
        <Btn onClick={go} busy={busy === "go"}>Run on growing networks</Btn>
      </div>
      <p className="hint">Each size: a seeded random network that converges, ingested into the isolated database, then converged by the reference (TypeScript, in the browser), by the server-side Cypher loop and by Pregel (concurrency 4, the unlicensed cap). The Pregel time includes projecting and dropping the in-memory graph.</p>
      {error && <Note tone="danger">{error}</Note>}
      {rows.length > 0 && <Table head={["network", "routers", "best routes", "rounds", "reference (browser)", "Cypher loop", "GDS Pregel", "speed-up", "all three identical"]}
        rows={rows.map((r) => [r.label, r.routers, r.routes.toLocaleString(), r.rounds, fmt(r.ref), fmt(r.loop), <b>{fmt(r.peg)}</b>, `${(r.loop / r.peg).toFixed(0)}×`, <span className={r.same ? "good" : "bad"}>{r.same ? "yes" : "NO"}</span>])} />}
    </div>
  );
}
