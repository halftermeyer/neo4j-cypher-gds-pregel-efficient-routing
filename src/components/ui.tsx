import type { ReactNode } from "react";
import { FilledButton, OutlinedButton, Banner } from "@neo4j-ndl/react";

export { Banner };

export function Btn({ children, onClick, busy, disabled, outlined, title }: { children: ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean; outlined?: boolean; title?: string }) {
  const B = outlined ? OutlinedButton : FilledButton;
  return (
    <span title={title}>
      <B size="medium" onClick={onClick} isDisabled={disabled || busy} isLoading={busy}>{children}</B>
    </span>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: "good" | "bad" | "warn" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="kpi-value">{value}</div>
      <div className="kpi-label">{label}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Verdict({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  if (ok === null) return <span className="status-warn">{children}</span>;
  return <span className={ok ? "status-pass" : "status-fail"}>{ok ? "✔ " : "✘ "}{children}</span>;
}

export const fmt = (ms: number) => (Number.isNaN(ms) ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : ms >= 100 ? `${Math.round(ms)} ms` : `${ms.toFixed(1)} ms`);

export function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Code({ children }: { children: string }) {
  return <pre className="code">{children.trim()}</pre>;
}

type Kind = "acl" | "kpaths" | "prune" | "fresh" | "vrf" | "bgp" | "batfish";

/** Open every scenario with the business problem, stated visually, before anything runs. */
export function Problem({ kind, title, objection, children }: { kind: Kind; title: string; objection: string; children: ReactNode }) {
  return (
    <div className="problem" data-testid="problem">
      <div className="problem-text">
        <div className="problem-tag">The objection</div>
        <h2>{title}</h2>
        <blockquote>“{objection}”</blockquote>
        <div className="problem-body">{children}</div>
      </div>
      <div className="problem-visual"><MiniDiagram kind={kind} /></div>
    </div>
  );
}

const RED = "#c62828", GREEN = "#2e7d32", BLUE = "#006fd6", GREY = "#9aa5b1";

function MiniDiagram({ kind }: { kind: Kind }) {
  const box = (x: number, y: number, t: string, c = BLUE) => (
    <g><rect x={x} y={y} width="46" height="24" rx="5" fill="white" stroke={c} strokeWidth="2" /><text x={x + 23} y={y + 16} textAnchor="middle" fontSize="11" fill={c}>{t}</text></g>
  );
  const line = (x1: number, y1: number, x2: number, y2: number, c = GREY, dash = false, w = 2) => <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={c} strokeWidth={w} strokeDasharray={dash ? "5 4" : undefined} />;
  const cross = (x: number, y: number) => <g stroke={RED} strokeWidth="3"><line x1={x - 7} y1={y - 7} x2={x + 7} y2={y + 7} /><line x1={x - 7} y1={y + 7} x2={x + 7} y2={y - 7} /></g>;
  const t = (x: number, y: number, s: string, c = "#333", w = "middle", sz = 11) => <text x={x} y={y} textAnchor={w as "middle"} fontSize={sz} fill={c}>{s}</text>;
  return (
    <svg viewBox="0 0 320 170" className="mini">
      {kind === "acl" && (<>
        {box(10, 70, "src")}{box(130, 70, "rtr")}{box(264, 70, "dst")}
        {line(56, 82, 130, 82, GREEN, false, 3)}{line(176, 82, 264, 82, GREEN, false, 3)}
        {t(155, 55, "in ACL → out ACL", "#333")}
        <rect x="108" y="100" width="90" height="48" rx="4" fill="#fff8e1" stroke="#f9a825" />
        {t(153, 116, "10 deny tcp/23", "#333", "middle", 10)}{t(153, 130, "20 permit tcp/443", GREEN, "middle", 10)}{t(153, 144, "implicit deny", RED, "middle", 10)}
      </>)}
      {kind === "kpaths" && (<>
        {box(8, 62, "A")}{box(266, 62, "B")}
        {[20, 62, 104].map((y, i) => <g key={i}>{line(54, 74, 160, y + 12, RED, false, 3)}{line(160, y + 12, 266, 74, RED, false, 3)}{cross(160, y + 12)}</g>)}
        {line(54, 74, 160, 146, GREEN, true, 3)}{line(160, 146, 266, 74, GREEN, true, 3)}
        {t(160, 14, "Yen top-3: all denied → post-filter = 0 paths", RED, "middle", 10)}{t(160, 166, "4th path is permitted", GREEN, "middle", 10)}
      </>)}
      {kind === "prune" && (<>
        {box(8, 62, "s")}
        {[[100, 20], [100, 62], [100, 104]].map(([x, y], i) => <g key={i}>{line(54, 74, x, y + 12, GREY)}{box(x, y, `n${i}`)}</g>)}
        {line(146, 32, 230, 20, GREY)}{line(146, 74, 230, 74, GREY)}{line(146, 116, 190, 130, RED, true)}{cross(196, 133)}
        {box(230, 8, "t")}{box(230, 62, "t")}
        {t(160, 160, "cost budget cuts branches DURING expansion", "#333", "middle", 10)}
      </>)}
      {kind === "fresh" && (<>
        <rect x="20" y="20" width="120" height="60" rx="6" fill="#eef5ff" stroke={BLUE} />{t(80, 45, "ACL changed", "#333")}{t(80, 62, "visible instantly", GREEN, "middle", 10)}
        <rect x="180" y="20" width="120" height="60" rx="6" fill="#fff3f0" stroke={RED} />{t(240, 45, "link added", "#333")}{t(240, 62, "projection stale → refresh", RED, "middle", 10)}
        <rect x="20" y="100" width="280" height="40" rx="6" fill="#f6f6f6" stroke={GREY} />{t(160, 125, "300k ACEs · concurrent flows · live numbers", "#333", "middle", 11)}
      </>)}
      {kind === "vrf" && (<>
        <rect x="10" y="12" width="140" height="70" rx="8" fill="#ffecec" stroke={RED} />{t(80, 30, "VRF RED", RED, "middle", 12)}
        <rect x="170" y="12" width="140" height="70" rx="8" fill="#e8f1ff" stroke={BLUE} />{t(240, 30, "VRF BLUE", BLUE, "middle", 12)}
        {line(70, 55, 100, 55, RED, false, 3)}{line(200, 55, 260, 55, BLUE, false, 3)}
        {line(110, 55, 200, 55, GREEN, true, 3)}{t(155, 105, "route leak: explicitly declared", GREEN, "middle", 10)}
        {t(160, 140, "isolation = one more per-flow filter", "#333", "middle", 11)}
      </>)}
      {kind === "bgp" && (<>
        {box(10, 20, "A")}{box(130, 20, "X")}{box(250, 20, "Z")}{box(70, 110, "Y")}
        {line(56, 32, 130, 32)}{line(176, 32, 250, 32)}{line(40, 44, 90, 110, GREY, true)}{line(116, 122, 270, 44, RED, true, 3)}
        {t(200, 118, "path query sees A→Y→Z", RED, "start", 10)}{t(200, 132, "but Y never advertises it", RED, "start", 10)}
        {t(160, 162, "BGP = fixed point of best-route choices, not a path search", "#333", "middle", 10)}
      </>)}
      {kind === "batfish" && (<>
        <rect x="14" y="30" width="120" height="50" rx="6" fill="#eef5ff" stroke={BLUE} />{t(74, 52, "Batfish", BLUE, "middle", 13)}{t(74, 68, "vendor-exact reference", "#333", "middle", 10)}
        <rect x="186" y="30" width="120" height="50" rx="6" fill="#eefaf0" stroke={GREEN} />{t(246, 52, "Neo4j", GREEN, "middle", 13)}{t(246, 68, "analysis + what-if", "#333", "middle", 10)}
        {line(134, 55, 186, 55, GREY, true, 3)}{t(160, 110, "reference ↔ graph: differences categorised", "#333", "middle", 11)}
      </>)}
    </svg>
  );
}

export function Note({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" | "success" | "danger" }) {
  return <Banner variant={tone}>{children}</Banner>;
}
