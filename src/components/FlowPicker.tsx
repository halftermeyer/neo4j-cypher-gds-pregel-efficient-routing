import { useApp } from "../ctx";
import { flowOf, leafPermitting, type Flow, type Topology } from "../lib/topology";

export type Preset = { label: string; src: string; dst: string; proto: string; port: number };
export function presetsOf(topo: Topology | null): Preset[] {
  const leaf = (topo && leafPermitting(topo, 443)) || "dc3-leaf1-h0";
  return [
    { label: "campus → DC web (tcp/443): permitted", src: "camp1-acc2-h0", dst: leaf, proto: "tcp", port: 443 },
    { label: "campus → DC ssh (tcp/22): explicit deny at the leaf", src: "camp1-acc2-h0", dst: leaf, proto: "tcp", port: 22 },
    { label: "guest subnet → DC (tcp/443): denied at the campus uplinks", src: "camp1-acc0-h0", dst: leaf, proto: "tcp", port: 443 },
    { label: "campus → DC telnet (tcp/23): denied at the spines", src: "camp1-acc2-h0", dst: leaf, proto: "tcp", port: 23 },
    { label: "campus → campus (tcp/7001): no ACL on the way", src: "camp1-acc2-h0", dst: "camp13-acc4-h0", proto: "tcp", port: 7001 },
  ];
}

export default function FlowPicker({ flow, onChange }: { flow: Flow; onChange: (f: Flow) => void }) {
  const { devices, topo } = useApp();
  const PRESETS = presetsOf(topo);
  const hosts = devices.filter((d) => d.role === "host").map((d) => d.name).sort();
  const set = (p: Partial<{ src: string; dst: string; proto: string; port: number }>) =>
    onChange(flowOf(devices, p.src ?? flow.src_host, p.dst ?? flow.dst_host, p.proto ?? flow.proto, p.port ?? flow.dport, flow.vrf));
  return (
    <div className="row">
      <label className="sel-label">preset
        <select className="sel" value="" onChange={(e) => { const p = PRESETS[+e.target.value]; if (p) set(p); }}>
          <option value="">choose…</option>{PRESETS.map((p, i) => <option key={i} value={i}>{p.label}</option>)}
        </select></label>
      <label className="sel-label">source<select className="sel" value={flow.src_host} onChange={(e) => set({ src: e.target.value })}>{hosts.map((h) => <option key={h}>{h}</option>)}</select></label>
      <label className="sel-label">destination<select className="sel" value={flow.dst_host} onChange={(e) => set({ dst: e.target.value })}>{hosts.map((h) => <option key={h}>{h}</option>)}</select></label>
      <label className="sel-label">protocol<select className="sel" value={flow.proto} onChange={(e) => set({ proto: e.target.value })}><option>tcp</option><option>udp</option><option>icmp</option></select></label>
      <label className="sel-label">port<input className="sel" style={{ width: 80 }} type="number" value={flow.dport} onChange={(e) => set({ port: +e.target.value })} /></label>
    </div>
  );
}
