// Hand-rolled deterministic SVG views: positions come from the data (site, AS), never from a force layout.
import type { Topology } from "../lib/topology";
import type { Net, Rib } from "../lib/bgp";
import { deviceSeq } from "../lib/kpath";

const W = 1000, H = 520, CX = 500, CY = 260;

export interface DrawPath { devs: string[]; color: string; dashed?: boolean; label?: string }
export interface Mark { node: string; color: string; label?: string }

/** Site-level node of a device: core routers are individual, everything else collapses to its campus / data centre. */
export const nodeOf = (dev: string) => (dev.startsWith("core") ? dev : dev.split("-")[0]);

function layout(topo: Topology): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>();
  const cores = topo.devices.filter((d) => d.role === "core").map((d) => d.name);
  cores.forEach((c, i) => { const a = (2 * Math.PI * i) / cores.length - Math.PI / 2; pos.set(c, { x: CX + 75 * Math.cos(a), y: CY + 75 * Math.sin(a) }); });
  const camps = [...new Set(topo.devices.filter((d) => d.site.startsWith("camp")).map((d) => d.site))];
  const dcs = [...new Set(topo.devices.filter((d) => d.site.startsWith("dc")).map((d) => d.site))];
  camps.forEach((c, i) => { const t = camps.length > 1 ? i / (camps.length - 1) : 0.5; const a = Math.PI * (0.58 + 0.84 * t); pos.set(c, { x: CX + 400 * Math.cos(a), y: CY + 215 * Math.sin(a) }); });
  dcs.forEach((c, i) => { const t = dcs.length > 1 ? i / (dcs.length - 1) : 0.5; const a = Math.PI * (-0.4 + 0.8 * t); pos.set(c, { x: CX + 400 * Math.cos(a), y: CY + 215 * Math.sin(a) }); });
  return pos;
}

export function TopoGraph({ topo, paths = [], marks = [], height = 420 }: { topo: Topology; paths?: DrawPath[]; marks?: Mark[]; height?: number }) {
  const pos = layout(topo);
  const skel = new Set<string>();
  const dev = new Map(topo.devices.map((d) => [d.name, d]));
  const ifDev = new Map(topo.ifaces.map((i) => [i.ifname, i.device]));
  for (const l of topo.links) {
    const a = nodeOf(ifDev.get(l.a)!), b = nodeOf(ifDev.get(l.b)!);
    if (a !== b) skel.add([a, b].sort().join("|"));
  }
  const seqOf = (devs: string[]) => deviceSeq(devs).map(nodeOf).filter((n, i, a) => i === 0 || n !== a[i - 1]);
  const used = new Set(paths.flatMap((p) => seqOf(p.devs)));
  const sites = [...pos.keys()];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="svgwrap" style={{ width: "100%", height }}>
      {[...skel].map((k) => { const [a, b] = k.split("|"); const p = pos.get(a), q = pos.get(b); return p && q ? <line key={k} x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="#d5dce8" strokeWidth="1" /> : null; })}
      {paths.map((p, pi) => {
        const s = seqOf(p.devs);
        const off = (pi - (paths.length - 1) / 2) * 4;
        return s.slice(1).map((n, i) => {
          const a = pos.get(s[i]), b = pos.get(n); if (!a || !b) return null;
          const dx = b.y - a.y, dy = a.x - b.x, len = Math.hypot(dx, dy) || 1;
          return <line key={`${pi}-${i}`} x1={a.x + (dx / len) * off} y1={a.y + (dy / len) * off} x2={b.x + (dx / len) * off} y2={b.y + (dy / len) * off} stroke={p.color} strokeWidth="3.2" strokeDasharray={p.dashed ? "7 5" : undefined} strokeLinecap="round" opacity=".9" />;
        });
      })}
      {sites.map((n) => {
        const p = pos.get(n)!; const core = n.startsWith("core"); const m = marks.find((x) => x.node === n);
        const on = used.has(n) || !!m;
        return (
          <g key={n}>
            <circle cx={p.x} cy={p.y} r={core ? 11 : 9} fill={core ? "#0b297d" : n.startsWith("dc") ? "#00b4d8" : "#006fd6"} opacity={on || !paths.length ? 1 : 0.35} stroke={m ? m.color : "white"} strokeWidth={m ? 4 : 1.5} />
            <text x={p.x} y={p.y + (n.startsWith("dc") ? 24 : n.startsWith("camp") ? -14 : 24)} textAnchor="middle" fontSize="10" fill="#334" opacity={on || !paths.length ? 1 : 0.5}>{n.replace("camp", "C").replace("core", "K")}</text>
            {m?.label && <text x={p.x} y={p.y - 16} textAnchor="middle" fontSize="11" fontWeight="700" fill={m.color}>{m.label}</text>}
          </g>
        );
      })}
      <text x="14" y="20" fontSize="12" fill="#667">campuses</text><text x={W - 14} y="20" textAnchor="end" fontSize="12" fill="#667">data centres</text>
      <text x={CX} y="20" textAnchor="middle" fontSize="12" fill="#667">core (K1…K6)</text>
      {dev.size === 0 && <text x={CX} y={CY} textAnchor="middle">no data</text>}
    </svg>
  );
}

// ───────────────────────── BGP ─────────────────────────
export interface BgpDraw { net: Net; rib?: Rib; prefix?: string; changed?: Set<string>; failed?: Set<string>; focus?: string }

export function BgpGraph({ net, rib, prefix, changed = new Set(), failed = new Set(), focus }: BgpDraw) {
  const BW = 760, BH = 440;
  const asns = [...new Set(Object.values(net.R).map((r) => r.asn))].sort((a, b) => a - b);
  const centers = new Map(asns.map((a, i) => { const t = (2 * Math.PI * i) / asns.length - Math.PI / 2; return [a, { x: BW / 2 + (asns.length > 1 ? 255 * Math.cos(t) : 0), y: BH / 2 + (asns.length > 1 ? 150 * Math.sin(t) : 0) }]; }));
  const pos = new Map<string, { x: number; y: number }>();
  for (const a of asns) {
    const rs = Object.values(net.R).filter((r) => r.asn === a).sort((x, y) => x.rid - y.rid);
    const rad = rs.length > 1 ? 24 + rs.length * 5 : 0;
    rs.forEach((r, i) => { const t = (2 * Math.PI * i) / rs.length - Math.PI / 2; const c = centers.get(a)!; pos.set(r.name, { x: c.x + rad * Math.cos(t), y: c.y + rad * Math.sin(t) }); });
  }
  const ebgp = new Map<string, [string, string]>(), ibgp = new Map<string, [string, string]>();
  for (const s of net.S) (s.type === "ebgp" ? ebgp : ibgp).set([s.a, s.b].sort().join("|"), [s.a, s.b]);
  const rid2name = new Map(Object.values(net.R).map((r) => [r.rid, r.name]));
  return (
    <svg viewBox={`0 0 ${BW} ${BH}`} className="svgwrap" style={{ width: "100%" }}>
      <defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#006fd6" /></marker></defs>
      {asns.map((a) => { const c = centers.get(a)!; const n = Object.values(net.R).filter((r) => r.asn === a).length; return (<g key={a}><circle cx={c.x} cy={c.y} r={34 + n * 6} fill="#eef3fb" stroke="#c7d4ea" strokeDasharray="4 3" /><text x={c.x} y={c.y - 40 - n * 6} textAnchor="middle" fontSize="10" fill="#667">AS {a}</text></g>); })}
      {[...ibgp.values()].map(([a, b]) => <line key={`i${a}${b}`} x1={pos.get(a)!.x} y1={pos.get(a)!.y} x2={pos.get(b)!.x} y2={pos.get(b)!.y} stroke="#dbe3ef" />)}
      {[...ebgp.values()].map(([a, b]) => { const dead = failed.has([a, b].sort().join("|")); return <line key={`e${a}${b}`} x1={pos.get(a)!.x} y1={pos.get(a)!.y} x2={pos.get(b)!.x} y2={pos.get(b)!.y} stroke={dead ? "#c62828" : "#9aa8bf"} strokeWidth={dead ? 2.5 : 1.6} strokeDasharray={dead ? "3 4" : undefined} />; })}
      {rib && prefix && [...rib].filter(([k]) => k.endsWith("|" + prefix)).map(([k, r]) => {
        const name = k.split("|")[0]; const from = rid2name.get(r.from_rid);
        if (r.learned === "local" || !from || from === name) return null;
        const a = pos.get(name)!, b = pos.get(from)!; const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
        return <line key={`a${k}`} x1={a.x + (dx / len) * 12} y1={a.y + (dy / len) * 12} x2={b.x - (dx / len) * 12} y2={b.y - (dy / len) * 12} stroke="#006fd6" strokeWidth="2" markerEnd="url(#arr)" transform="" opacity=".85" />;
      })}
      {Object.values(net.R).map((r) => {
        const p = pos.get(r.name)!; const route = rib && prefix ? rib.get(`${r.name}|${prefix}`) : undefined;
        const origin = !!prefix && r.orig.includes(prefix);
        return (
          <g key={r.name}>
            <circle cx={p.x} cy={p.y} r="11" fill={origin ? "#2e7d32" : route ? "#006fd6" : "#c9d1dd"} stroke={changed.has(r.name) ? "#f9a825" : focus === r.name ? "#0b297d" : "white"} strokeWidth={changed.has(r.name) ? 5 : 2} />
            <text x={p.x} y={p.y + 25} textAnchor="middle" fontSize="9" fill="#334">{r.name}{r.soo ? ` ·SOO ${r.soo}` : ""}</text>
          </g>
        );
      })}
    </svg>
  );
}
