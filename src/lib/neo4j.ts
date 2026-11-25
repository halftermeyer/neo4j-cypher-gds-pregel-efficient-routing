import neo4j, { Driver, Integer } from "neo4j-driver";

declare const __CFG__: { uri: string; user: string; password: string; database: string; batfish: string };
export const CFG = __CFG__;
export const MAIN_DB = CFG.database;
/** Isolated database used by every benchmark: the demo data in MAIN_DB is never touched by them. */
export const BENCH_DB = "netdt-bench";

let driver: Driver | null = null;
export function getDriver(): Driver {
  if (!driver) driver = neo4j.driver(CFG.uri, neo4j.auth.basic(CFG.user, CFG.password));
  return driver;
}

// ── Query audit log: every statement the app runs, with parameters and timing ──
export interface QueryLogEntry {
  id: number;
  timestamp: Date;
  cypher: string;
  params: Record<string, unknown>;
  database: string;
  durationMs: number;
  rowCount: number;
  results?: unknown[];
  error?: string;
  group?: string;
}
export interface QueryGroup {
  label: string;
  entries: QueryLogEntry[];
  totalMs: number;
  totalRows: number;
  hasError: boolean;
}

let counter = 0;
let log: QueryLogEntry[] = [];
let currentGroup: string | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
const MAX_LOG = 3000;

export const getQueryLog = () => log;
export const clearQueryLog = () => { log = []; notify(); };
export const onQueryLogChange = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

/** Group every query issued inside fn under a label in the audit drawer. */
export async function withGroup<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const prev = currentGroup;
  currentGroup = label;
  try { return await fn(); } finally { currentGroup = prev; }
}

export function getGroupedLog(): QueryGroup[] {
  const groups: QueryGroup[] = [];
  let label: string | null = null;
  let cur: QueryLogEntry[] = [];
  const flush = () => {
    if (!cur.length) return;
    groups.push({
      label: label || cur[0].cypher.split("\n")[0].trim().substring(0, 60),
      entries: cur,
      totalMs: cur.reduce((s, e) => s + e.durationMs, 0),
      totalRows: cur.reduce((s, e) => s + e.rowCount, 0),
      hasError: cur.some((e) => e.error),
    });
    cur = [];
  };
  for (const e of log) {
    if ((e.group || null) !== label) { flush(); label = e.group || null; }
    cur.push(e);
  }
  flush();
  return groups;
}

/** Default server-side timeout (ms) applied to every query that does not set its own; benchmarks switch it on. */
export const defaults: { timeoutMs?: number } = {};

export interface RunOpts {
  database?: string;
  /** Server-side transaction timeout in MILLISECONDS (neo4j-driver TransactionConfig.timeout is in ms). */
  timeoutMs?: number;
  /** Do not record in the audit drawer (used by high-volume benchmark loops, which log one summary instead). */
  silent?: boolean;
}

export function toJS(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  if (neo4j.isInt(val)) return (val as Integer).inSafeRange() ? (val as Integer).toNumber() : (val as Integer).toString();
  if (Array.isArray(val)) return val.map(toJS);
  if (typeof val === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as object)) o[k] = toJS(v);
    return o;
  }
  return val;
}

/** JS numbers are sent as Bolt floats by default; range(), list indexing etc. need integers, so integral numbers become Bolt integers. */
export function toBolt(v: unknown): unknown {
  if (typeof v === "number") return Number.isInteger(v) ? neo4j.int(v) : v;
  if (Array.isArray(v)) return v.map(toBolt);
  if (v && typeof v === "object" && !neo4j.isInt(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toBolt(x)]));
  return v;
}

export async function runQuery<T = Record<string, unknown>>(
  cypher: string,
  params: Record<string, unknown> = {},
  opts: RunOpts = {},
): Promise<T[]> {
  const database = opts.database || MAIN_DB;
  const session = getDriver().session({ database });
  const t0 = performance.now();
  const id = ++counter;
  const record = (rows: unknown[], error?: string) => {
    if (opts.silent) return;
    log = [...log, {
      id, timestamp: new Date(), cypher: cypher.trim(), params, database,
      durationMs: Math.round(performance.now() - t0), rowCount: rows.length,
      results: rows.slice(0, 20), error, group: currentGroup || undefined,
    }].slice(-MAX_LOG);
    notify();
  };
  try {
    const res = await session.run(cypher, toBolt(params) as Record<string, unknown>, (opts.timeoutMs ?? defaults.timeoutMs) ? { timeout: opts.timeoutMs ?? defaults.timeoutMs } : undefined);
    const rows = res.records.map((r) => {
      const o: Record<string, unknown> = {};
      r.keys.forEach((k) => { o[k as string] = toJS(r.get(k)); });
      return o as T;
    });
    record(rows);
    return rows;
  } catch (e) {
    record([], (e as Error).message);
    throw e;
  } finally {
    await session.close();
  }
}

// ── EXPLAIN / PROFILE helpers (scenario 3: show that pruning happens during expansion) ──
export interface PlanNode {
  operator: string;
  details: string;
  rows?: number;
  dbHits?: number;
  children: PlanNode[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPlan(p: any): PlanNode {
  const a = p.arguments || {};
  const num = (v: unknown) => (v === undefined ? undefined : Number(toJS(v)));
  return {
    operator: p.operatorType,
    details: String(toJS(a.Details ?? a.details ?? "")),
    rows: num(p.rows ?? p.profile?.rows ?? a.Rows),
    dbHits: num(p.dbHits ?? p.profile?.dbHits ?? a.DbHits),
    children: (p.children || []).map(toPlan),
  };
}

export async function planOf(
  mode: "EXPLAIN" | "PROFILE",
  cypher: string,
  params: Record<string, unknown>,
  opts: RunOpts = {},
): Promise<{ plan: PlanNode; ms: number }> {
  const database = opts.database || MAIN_DB;
  const session = getDriver().session({ database });
  const t0 = performance.now();
  const id = ++counter;
  try {
    const res = await session.run(`${mode} ${cypher}`, toBolt(params) as Record<string, unknown>, opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
    const summary = res.summary;
    const p = mode === "PROFILE" ? summary.profile : summary.plan;
    const ms = Math.round(performance.now() - t0);
    log = [...log, {
      id, timestamp: new Date(), cypher: `${mode} ${cypher}`.trim(), params, database, durationMs: ms,
      rowCount: res.records.length, group: currentGroup || undefined,
    }].slice(-MAX_LOG);
    notify();
    return { plan: toPlan(p), ms };
  } finally {
    await session.close();
  }
}

export function flattenPlan(p: PlanNode, depth = 0): { depth: number; node: PlanNode }[] {
  return [{ depth, node: p }, ...p.children.flatMap((c) => flattenPlan(c, depth + 1))];
}
export const totalDbHits = (p: PlanNode): number => (p.dbHits || 0) + p.children.reduce((s, c) => s + totalDbHits(c), 0);

export const median = (xs: number[]) => pct(xs, 50);
export function pct(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round((p / 100) * (s.length - 1)))];
}
