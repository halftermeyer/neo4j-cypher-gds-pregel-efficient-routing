// Translate the toy BGP model into Cisco IOS configurations (for Batfish). Choices needed to make IOS behave like the stated model:
//  - bgp always-compare-med (the model compares MED across neighbour ASes), bgp bestpath compare-routerid (model breaks ties on router-id)
//  - iBGP over direct links with next-hop-self (no IGP in the model); send-community on every session
//  - SOO is EMULATED: the origin tags a standard community per site and every session towards a router of that site denies it outbound
//  - model communities 'c:N' -> '100:N'; SOO site k -> '65001:k'; AS-path prepend only on eBGP sessions
import type { Entry, Net, Rib, Route } from "./bgp";
import { canon } from "./bgp";

const comm = (c: string, soo: Record<string, number>) => (c.startsWith("c:") ? "100:" + c.slice(2) : `65001:${soo[c.slice(4)]}`);
const ipOf = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const BASE = (172 * 256 + 16) * 65536;
const mask = (len: number) => ipOf(len === 0 ? 0 : (0xffffffff << (32 - len)) >>> 0);
const netOf = (p: string) => { const [a, l] = p.split("/"); return `${a} ${mask(+l)}`; };

export interface Ios { files: Record<string, string>; peerOfIp: Map<string, string>; sooIds: Record<string, number> }

function rmEntry(rm: string, seq: number, e: Entry, stype: string, asn: number, pl: Record<string, string>): string[] {
  const L = [`route-map ${rm} ${e.act} ${seq}`];
  if (e.pfx) L.push(` match ip address prefix-list ${pl[e.pfx]}`);
  if (e.comm) L.push(` match community CL_${e.comm.replace(":", "_")}`);
  if (e.act === "permit") {
    if (e.lp >= 0) L.push(` set local-preference ${e.lp}`);
    if (e.med >= 0) L.push(` set metric ${e.med}`);
    if (e.add) L.push(` set community ${comm(e.add, {})} additive`);
    if (e.prep > 0 && stype === "ebgp") L.push(" set as-path prepend " + Array(e.prep).fill(asn).join(" "));
  }
  L.push("!");
  return L;
}

export function toIos(net: Net): Ios {
  const { R, S } = net;
  const sooIds: Record<string, number> = {};
  [...new Set(Object.values(R).map((r) => r.soo).filter(Boolean) as string[])].sort().forEach((s, i) => (sooIds[s] = i + 1));
  const pairs = [...new Set(S.map((s) => [s.a, s.b].sort().join("|")))].sort().map((k) => k.split("|") as [string, string]);
  const ip = new Map<string, string>();
  pairs.forEach(([x, y], k) => { ip.set(`${x}|${y}`, ipOf(BASE + 2 * k)); ip.set(`${y}|${x}`, ipOf(BASE + 2 * k + 1)); });
  const sess = new Map(S.map((s) => [`${s.a}|${s.b}`, s]));
  const allComms = new Set<string>();
  for (const s of S) for (const side of [s.exp, s.imp]) for (const e of side ?? []) for (const c of [e.comm, e.add]) if (c) allComms.add(c);
  const prefixes = [...new Set([...Object.values(R).flatMap((r) => r.orig), ...S.flatMap((s) => [...(s.exp ?? []), ...(s.imp ?? [])].map((e) => e.pfx).filter(Boolean))])].sort();
  const pl: Record<string, string> = Object.fromEntries(prefixes.map((p, i) => [p, `PL${i}`]));
  const files: Record<string, string> = {};
  for (const [n, r] of Object.entries(R)) {
    const rid = `10.255.${r.rid >> 8}.${r.rid & 255}`;
    const L = [`hostname ${n}`, "!", "interface Loopback0", ` ip address ${rid} 255.255.255.255`, "!"];
    const peers = [...new Set([...S.filter((s) => s.a === n).map((s) => s.b), ...S.filter((s) => s.b === n).map((s) => s.a)])].sort();
    peers.forEach((p, i) => L.push(`interface GigabitEthernet0/${i}`, ` ip address ${ip.get(`${n}|${p}`)} 255.255.255.254`, " no shutdown", "!"));
    for (const p of r.orig) L.push(`ip route ${netOf(p)} Null0`);
    for (const [p, name] of Object.entries(pl)) L.push(`ip prefix-list ${name} seq 5 permit ${p}`);
    for (const c of [...allComms].sort()) L.push(`ip community-list standard CL_${c.replace(":", "_")} permit ${comm(c, sooIds)}`);
    for (const [site, k] of Object.entries(sooIds)) L.push(`ip community-list standard SOO_${site} permit 65001:${k}`);
    L.push("!");
    if (r.soo) L.push("route-map ORIG permit 10", ` set community 65001:${sooIds[r.soo]}`, "!");
    const nb: string[] = [];
    for (const p of peers) {
      const peer = R[p], pip = ip.get(`${p}|${n}`)!;
      nb.push(` neighbor ${pip} remote-as ${peer.asn}`, ` neighbor ${pip} send-community`);
      if (peer.asn === r.asn) nb.push(` neighbor ${pip} next-hop-self`);
      const out = sess.get(`${n}|${p}`), inn = sess.get(`${p}|${n}`);
      if (out && (out.exp || peer.soo)) {
        const rm = `OUT_${p}`;
        if (peer.soo) L.push(`route-map ${rm} deny 1`, ` match community SOO_${peer.soo}`, "!");
        (out.exp ?? [{ pfx: "", comm: "", act: "permit", lp: -1, add: "", med: -1, prep: 0 } as Entry]).forEach((e, j) => L.push(...rmEntry(rm, 10 * (j + 1), e, out.type, r.asn, pl)));
        nb.push(` neighbor ${pip} route-map ${rm} out`);
      }
      if (inn?.imp) {
        const rm = `IN_${p}`;
        inn.imp.forEach((e, j) => L.push(...rmEntry(rm, 10 * (j + 1), e, inn.type, r.asn, pl)));
        nb.push(` neighbor ${pip} route-map ${rm} in`);
      }
    }
    L.push(`router bgp ${r.asn}`, ` bgp router-id ${rid}`, " bgp always-compare-med", " bgp bestpath compare-routerid", ...nb);
    for (const p of r.orig) L.push(` network ${netOf(p).replace(" ", " mask ")}` + (r.soo ? " route-map ORIG" : ""));
    L.push("!", "end", "");
    files[`${n}.cfg`] = L.join("\n");
  }
  const peerOfIp = new Map<string, string>();
  for (const [k, v] of ip) peerOfIp.set(v, k.split("|")[0]);
  return { files, peerOfIp, sooIds };
}

export interface BfRow { node: string; network: string; local_pref: number; as_path: string; metric: number; received_from_ip: string; communities: string[] }

/** Normalise Batfish best routes into the model's shape, to compare with the Neo4j routing tables. */
export function fromBatfish(rows: BfRow[], net: Net, ios: Ios): Map<string, { lp: number; aspath: number[]; med: number; learned: string; from: string; comms: string[] }> {
  const out = new Map<string, { lp: number; aspath: number[]; med: number; learned: string; from: string; comms: string[] }>();
  const names = Object.keys(net.R);
  for (const r of rows) {
    const router = names.find((x) => x.toLowerCase() === r.node.toLowerCase());
    if (!router) continue;
    const from = ["0.0.0.0", "AUTO/NONE(-1l)", "None", ""].includes(r.received_from_ip) ? router : ios.peerOfIp.get(r.received_from_ip) ?? r.received_from_ip;
    const learned = from === router ? "local" : net.R[from]?.asn === net.R[router].asn ? "ibgp" : "ebgp";
    out.set(`${router}|${r.network}`, { lp: r.local_pref, aspath: r.as_path.trim() ? r.as_path.trim().split(/\s+/).map(Number) : [], med: r.metric, learned, from, comms: r.communities.sort() });
  }
  return out;
}

export function modelView(rib: Rib, net: Net, ios: Ios) {
  const rid2 = new Map(Object.values(net.R).map((r) => [r.rid, r.name]));
  const m = new Map<string, { lp: number; aspath: number[]; med: number; learned: string; from: string; comms: string[] }>();
  for (const [k, v] of rib as Map<string, Route>) m.set(k, { lp: v.lp, aspath: v.aspath, med: v.med, learned: v.learned, from: rid2.get(v.from_rid)!, comms: v.comms.map((c) => comm(c, ios.sooIds)).sort() });
  return m;
}

type V = { lp: number; aspath: number[]; med: number; learned: string; from: string; comms: string[] };
export const sameV = (x: V | undefined, y: V | undefined) => !!x && !!y && x.lp === y.lp && x.aspath.join() === y.aspath.join() && x.med === y.med && x.learned === y.learned && x.from === y.from && x.comms.join() === y.comms.join();

/** Categorise one difference, from the spike's report. */
export function classify(bf: V | undefined, md: V | undefined): string {
  if (!bf || !md) return "route present in one side only";
  if (bf.lp === md.lp && bf.aspath.join() === md.aspath.join() && bf.med === md.med && bf.learned === md.learned && bf.from === md.from) return "same route, different community set (IOS community handling vs the model)";
  if (bf.lp === md.lp && bf.aspath.length === md.aspath.length && bf.med === md.med && bf.learned === md.learned) return "tie-break: same preference, AS-path length, MED and type; a different neighbour was chosen";
  if (bf.lp === md.lp && bf.aspath.length === md.aspath.length && bf.learned !== md.learned) return "MED rule: iBGP vs eBGP path from the same neighbour AS";
  if (bf.lp === md.lp && bf.aspath.length === md.aspath.length && bf.aspath.join() === md.aspath.join()) return "same path, different attributes (MED / communities)";
  return "different local-pref or AS-path length: knock-on effect of an earlier difference";
}
export { canon };
