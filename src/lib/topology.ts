// Deterministic campus / core / data-centre topology with per-interface ACLs (seeded).
//
// Model (identical to the validated spike):
//   (:Device)-[:HAS_IF]->(:Iface {dir:'in'|'out'})          two nodes per physical interface
//   cable   (A.out)-[:LINK {id,cost}]->(B.in)               one per direction
//   forward (x.in)-[:FWD {cost}]->(y.out), x<>y             inside a device: a path never chains two FWD hops
//   ACL     parallel lists on the interface node (in_* on the 'in' node, out_* on the 'out' node), IPv4 ranges as integers
import { Rng } from "./rng";

export const ANY_IP: [number, number] = [0, 4294967295];
export const ANY_PORT: [number, number] = [0, 65535];

export function ipInt(s: string): number {
  const p = s.split(".").map(Number);
  return ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}
export function ipStr(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
export function cidr(s: string): [number, number] {
  const [a, l] = s.split("/");
  const len = Number(l);
  const size = 2 ** (32 - len);
  const lo = Math.floor(ipInt(a) / size) * size;
  return [lo, lo + size - 1];
}

export interface Ace {
  seq: number;
  action: "permit" | "deny";
  proto: string;
  src?: string;
  dst?: string;
  dp?: [number, number];
}

export function aceLists(aces: Ace[], dir: "in" | "out"): Record<string, unknown> {
  const s = [...aces].sort((a, b) => a.seq - b.seq);
  const p = (k: string) => `${dir}_${k}`;
  return {
    [p("seqs")]: s.map((a) => a.seq),
    [p("actions")]: s.map((a) => a.action),
    [p("protos")]: s.map((a) => a.proto),
    [p("src_lo")]: s.map((a) => (a.src ? cidr(a.src) : ANY_IP)[0]),
    [p("src_hi")]: s.map((a) => (a.src ? cidr(a.src) : ANY_IP)[1]),
    [p("dst_lo")]: s.map((a) => (a.dst ? cidr(a.dst) : ANY_IP)[0]),
    [p("dst_hi")]: s.map((a) => (a.dst ? cidr(a.dst) : ANY_IP)[1]),
    [p("dp_lo")]: s.map((a) => (a.dp ?? ANY_PORT)[0]),
    [p("dp_hi")]: s.map((a) => (a.dp ?? ANY_PORT)[1]),
  };
}

export interface Device { name: string; role: string; site: string; ip?: number; subnet?: string; did: number }
export interface IfaceRow { name: string; ifname: string; device: string; dir: "in" | "out"; nid: number; did: number; [k: string]: unknown }
export interface Topology {
  devices: Device[];
  ifaces: IfaceRow[];
  links: { a: string; b: string; id: number; cost: number }[];
  aceCount: number;
  aclIfaces: number;
}

export interface TopoOpts { seed?: number; campuses?: number; dcs?: number }

export function generateTopology(o: TopoOpts = {}): Topology {
  const rnd = new Rng(o.seed ?? 42);
  const N_CORE = 6, N_CAMPUS = o.campuses ?? 24, N_ACCESS = 6, N_DC = o.dcs ?? 10, N_LEAF = 5;
  const devs = new Map<string, Omit<Device, "did">>();
  const ifaces = new Map<string, { name: string; device: string }>();
  const links: { a: string; b: string; cost: number }[] = [];
  const ifcount = new Map<string, number>();
  const dev = (name: string, role: string, site: string, extra: Partial<Device> = {}) => devs.set(name, { name, role, site, ...extra });
  const newIf = (d: string) => {
    const n = (ifcount.get(d) ?? 0) + 1;
    ifcount.set(d, n);
    const nm = `${d}:e${n}`;
    ifaces.set(nm, { name: nm, device: d });
    return nm;
  };
  const link = (a: string, b: string, cost: number) => links.push({ a: newIf(a), b: newIf(b), cost });

  const cores = Array.from({ length: N_CORE }, (_, i) => `core${i + 1}`);
  cores.forEach((c) => dev(c, "core", "core"));
  for (let i = 0; i < N_CORE; i++) link(cores[i], cores[(i + 1) % N_CORE], rnd.choice([10, 15, 20]));
  for (let i = 0; i < N_CORE / 2; i++) link(cores[i], cores[i + N_CORE / 2], rnd.choice([20, 30]));

  for (let c = 0; c < N_CAMPUS; c++) {
    const s = `camp${c}`, d1 = `${s}-dist1`, d2 = `${s}-dist2`;
    dev(d1, "dist", s); dev(d2, "dist", s);
    link(d1, cores[c % N_CORE], rnd.choice([20, 30, 40])); link(d1, cores[(c + 1) % N_CORE], rnd.choice([20, 30, 40]));
    link(d2, cores[(c + 2) % N_CORE], rnd.choice([20, 30, 40])); link(d2, cores[(c + 3) % N_CORE], rnd.choice([20, 30, 40]));
    link(d1, d2, 10);
    for (let a = 0; a < N_ACCESS; a++) {
      const ac = `${s}-acc${a}`;
      dev(ac, "access", s);
      link(ac, d1, 10); link(ac, d2, 10);
      const hn = `${s}-acc${a}-h0`;
      dev(hn, "host", s, { ip: ipInt(`10.${c}.${a}.10`), subnet: `10.${c}.${a}.0/24` });
      link(hn, ac, 1);
    }
  }

  const dcServices = [22, 80, 443, 3306, 5432, 8443, 9200];
  const leafSubnet = new Map<string, string>(), leafServices = new Map<string, number[]>();
  for (let d = 0; d < N_DC; d++) {
    const s = `dc${d}`, sp = [`${s}-spine1`, `${s}-spine2`];
    sp.forEach((x) => dev(x, "spine", s));
    link(sp[0], cores[d % N_CORE], rnd.choice([10, 20])); link(sp[1], cores[(d + 3) % N_CORE], rnd.choice([10, 20]));
    for (let l = 0; l < N_LEAF; l++) {
      const lf = `${s}-leaf${l}`;
      dev(lf, "leaf", s);
      sp.forEach((x) => link(lf, x, 5));
      const hn = `${s}-leaf${l}-h0`, sub = `10.${100 + d}.${l}.0/24`;
      dev(hn, "host", s, { ip: ipInt(`10.${100 + d}.${l}.10`), subnet: sub });
      link(hn, lf, 1);
      leafSubnet.set(lf, sub);
      leafServices.set(lf, rnd.sample(dcServices, 3 + rnd.randrange(3)).sort((x, y) => x - y));
    }
  }

  // ACLs
  const acl = new Map<string, { in?: Ace[]; out?: Ace[] }>();
  const set = (n: string, dir: "in" | "out", aces: Ace[]) => acl.set(n, { ...(acl.get(n) ?? {}), [dir]: aces });
  const ace = (seq: number, action: "permit" | "deny", proto: string, src?: string, dst?: string, dp?: [number, number]): Ace => ({ seq, action, proto, src, dst, dp });
  for (const l of links) {
    for (const [me, peer] of [[l.a, l.b], [l.b, l.a]] as const) {
      const dm = devs.get(ifaces.get(me)!.device)!, dp = devs.get(ifaces.get(peer)!.device)!;
      if (dm.role === "leaf" && dp.role === "host") {
        const sub = leafSubnet.get(dm.name)!;
        const aces = [ace(5, "deny", "tcp", "10.0.0.0/11", sub, [22, 22])];
        leafServices.get(dm.name)!.forEach((p, i) => aces.push(ace(10 + 10 * i, "permit", "tcp", undefined, sub, [p, p])));
        aces.push(ace(100, "permit", "icmp", undefined, sub), ace(999, "deny", "ip"));
        set(me, "out", aces);
      }
      if (dm.role === "spine" && dp.role === "core") set(me, "in", [ace(10, "deny", "tcp", undefined, undefined, [23, 23]), ace(20, "deny", "udp", undefined, undefined, [69, 69]), ace(1000, "permit", "ip")]);
      if (dm.role === "dist" && dp.role === "core") set(me, "out", [ace(10, "deny", "ip", `10.${dm.site.slice(4)}.0.0/24`, "10.96.0.0/12"), ace(1000, "permit", "ip")]);
    }
  }

  const devices: Device[] = [...devs.values()].map((d, i) => ({ ...d, did: i }));
  const didOf = new Map(devices.map((d) => [d.name, d.did]));
  const rows: IfaceRow[] = [];
  let nid = 0, aceCount = 0;
  const aclSet = new Set<string>();
  for (const [n, i] of ifaces) {
    for (const dir of ["in", "out"] as const) {
      const r: IfaceRow = { name: `${n}:${dir}`, ifname: n, device: i.device, dir, nid: nid++, did: didOf.get(i.device)! };
      const aces = acl.get(n)?.[dir];
      if (aces) { Object.assign(r, aceLists(aces, dir)); aceCount += aces.length; aclSet.add(r.name); }
      rows.push(r);
    }
  }
  return { devices, ifaces: rows, links: links.map((l, id) => ({ ...l, id, cost: l.cost })), aceCount, aclIfaces: aclSet.size };
}

export interface Flow { src: number; dst: number; proto: string; dport: number; src_host: string; dst_host: string; vrf?: string }

/** The seeded flow set (70% campus->DC, 30% campus->campus), same recipe as the spike's 100 flows. */
export function seededFlows(devices: Device[], n = 100, seed = 7): Flow[] {
  const hosts = devices.filter((d) => d.role === "host").sort((a, b) => (a.name < b.name ? -1 : 1));
  const camp = hosts.filter((h) => h.name.startsWith("camp")), dc = hosts.filter((h) => h.name.startsWith("dc"));
  const rnd = new Rng(seed);
  const out: Flow[] = [];
  for (let i = 0; i < n; i++) {
    const src = rnd.choice(camp);
    let dst = rnd.choice(rnd.next() < 0.7 ? dc : camp);
    if (src.name === dst.name) dst = rnd.choice(dc);
    out.push({
      src: src.ip!, dst: dst.ip!, src_host: src.name, dst_host: dst.name,
      proto: rnd.choice(["tcp", "tcp", "tcp", "udp", "icmp"]),
      dport: rnd.choice([22, 80, 443, 3306, 5432, 8443, 9200, 53]),
    });
  }
  return out;
}

export const flowOf = (devices: Device[], srcHost: string, dstHost: string, proto: string, dport: number, vrf?: string): Flow => {
  const s = devices.find((d) => d.name === srcHost)!, d = devices.find((x) => x.name === dstHost)!;
  return { src: s.ip!, dst: d.ip!, proto, dport, src_host: srcHost, dst_host: dstHost, vrf };
};

/** First data-centre host whose leaf ACL permits tcp/port (null if none): used to build presets that show real ACE decisions. */
export function leafPermitting(topo: Topology, port: number, not?: number): string | null {
  for (const i of topo.ifaces) {
    if (i.dir !== "out" || !i.device.includes("-leaf") || !i.out_seqs) continue;
    const acts = i.out_actions as string[], protos = i.out_protos as string[], lo = i.out_dp_lo as number[];
    const permits = (p: number) => acts.some((a, k) => a === "permit" && protos[k] === "tcp" && lo[k] === p);
    if (permits(port) && (not === undefined || !permits(not))) return `${i.device}-h0`;
  }
  return null;
}
