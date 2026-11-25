// Cypher building blocks for the ACL model. Two storages of the same ACLs, one semantics:
//   list model : ACEs as parallel lists on the interface node (in_seqs / out_seqs ...)
//   node model : (:Iface)-[:ACE]->(:Ace {seq, action, proto, src_lo, ...}), ordered by seq
// Semantics: first match by sequence number wins, implicit deny at the end, an interface without ACL permits everything.

/** Does ACE number k of the list ACL (direction d) on interface variable v match flow variable f? */
export const listMatch = (v: string, d: "in" | "out", f: string) =>
  `(${v}.${d}_protos[k] = 'ip' OR ${v}.${d}_protos[k] = ${f}.proto) ` +
  `AND ${v}.${d}_src_lo[k] <= ${f}.src <= ${v}.${d}_src_hi[k] ` +
  `AND ${v}.${d}_dst_lo[k] <= ${f}.dst <= ${v}.${d}_dst_hi[k] ` +
  `AND ${v}.${d}_dp_lo[k] <= ${f}.dport AND ${f}.dport <= ${v}.${d}_dp_hi[k]`;

/** Boolean: is the flow permitted by the d-ACL on v (list model). */
export const verdict = (v: string, d: "in" | "out", f = "f") =>
  `(${v}.${d}_seqs IS NULL OR coalesce(head([k IN range(0, coalesce(size(${v}.${d}_seqs), 0) - 1) WHERE ${listMatch(v, d, f)} | ${v}.${d}_actions[k] = 'permit']), false))`;

/** Map {seq, action} of the deciding ACE (list model), or null when no ACE matches (implicit deny) / no ACL. */
export const decidingList = (v: string, d: "in" | "out", f = "f") =>
  `CASE WHEN ${v}.${d}_seqs IS NULL THEN null ELSE head([k IN range(0, size(${v}.${d}_seqs) - 1) WHERE ${listMatch(v, d, f)} | {seq: ${v}.${d}_seqs[k], action: ${v}.${d}_actions[k]}]) END`;

export const aceNodeMatch = (e: string, f: string) =>
  `(${e}.proto = 'ip' OR ${e}.proto = ${f}.proto) AND ${e}.src_lo <= ${f}.src <= ${e}.src_hi AND ${e}.dst_lo <= ${f}.dst <= ${e}.dst_hi AND ${e}.dp_lo <= ${f}.dport <= ${e}.dp_hi`;

/** Interfaces whose ACL (node model) denies the flow: ORDER BY seq LIMIT 1 is the first-match rule. */
export const BLOCKED_NODE_MODEL = `
WITH $flow AS f
MATCH (i:Iface) WHERE EXISTS { (i)-[:ACE]->(:Ace) }
CALL (i, f) {
  OPTIONAL MATCH (i)-[:ACE]->(e:Ace) WHERE ${aceNodeMatch("e", "f")}
  RETURN e.action AS action ORDER BY e.seq LIMIT 1
}
WITH i, action WHERE coalesce(action, 'deny') <> 'permit'
RETURN collect(i.nid) AS blocked`;

/** Blocked interface set, list model, plus the VRF constraint (an interface of another VRF is as good as denied). */
export const BLOCKED_LIST_MODEL = `
WITH $flow AS f
MATCH (i:Iface)
WHERE (i.dir = 'in'  AND i.in_seqs  IS NOT NULL AND NOT ${verdict("i", "in")})
   OR (i.dir = 'out' AND i.out_seqs IS NOT NULL AND NOT ${verdict("i", "out")})
   OR (f.vrf IS NOT NULL AND i.vrf IS NOT NULL AND NOT (i.vrf = f.vrf OR f.vrf IN coalesce(i.vrf_leak, [])))
RETURN collect(i.nid) AS blocked`;

/** Which ACE decides at each device crossing of a path (both storages), for one flow. */
export const HOP_DECISIONS = `
WITH $flow AS f, $ifs AS ifs
UNWIND range(0, size(ifs) - 2) AS i
MATCH (a:Iface {name: ifs[i]}), (b:Iface {name: ifs[i + 1]})
WHERE a.dir = 'in' AND b.dir = 'out' AND a.device = b.device
CALL (a, f) {
  OPTIONAL MATCH (a)-[:ACE]->(e:Ace) WHERE ${aceNodeMatch("e", "f")}
  RETURN e.seq AS in_seq_n, e.action AS in_act_n ORDER BY e.seq LIMIT 1
}
CALL (b, f) {
  OPTIONAL MATCH (b)-[:ACE]->(e:Ace) WHERE ${aceNodeMatch("e", "f")}
  RETURN e.seq AS out_seq_n, e.action AS out_act_n ORDER BY e.seq LIMIT 1
}
RETURN i AS pos, a.device AS device, a.ifname AS inIf, b.ifname AS outIf,
       ${decidingList("a", "in")} AS inList, ${decidingList("b", "out")} AS outList,
       EXISTS { (a)-[:ACE]->(:Ace) } AS inHasAcl, EXISTS { (b)-[:ACE]->(:Ace) } AS outHasAcl,
       {seq: in_seq_n, action: in_act_n} AS inNode, {seq: out_seq_n, action: out_act_n} AS outNode
ORDER BY pos`;

/** K cheapest paths on a GDS graph (Yen). Weights = link cost. */
export const YEN = `
MATCH (s:Iface {device: $src, dir: 'out'}), (t:Iface {device: $dst, dir: 'in'})
CALL gds.shortestPath.yens.stream($g, {sourceNode: s, targetNode: t, k: $k, relationshipWeightProperty: 'cost'})
YIELD index, totalCost, path
RETURN index, totalCost AS cost, [n IN nodes(path) | n.name] AS ifs, [n IN nodes(path) | n.device] AS devs`;

/** Variant (a): projection of the allowed edges only, rebuilt per flow (always current). */
export const PROJECT_PER_FLOW = `
WITH $flow AS f, $xdev AS xdev, $xlink AS xlink, $applyAcl AS applyAcl
MATCH (a:Iface)-[r:LINK|FWD]->(b:Iface)
WHERE NOT a.device IN xdev AND NOT b.device IN xdev
  AND (type(r) <> 'LINK' OR NOT r.id IN xlink)
  AND (NOT applyAcl OR type(r) = 'LINK' OR (${verdict("a", "in")} AND ${verdict("b", "out")}))
  AND (NOT applyAcl OR f.vrf IS NULL OR ((a.vrf IS NULL OR a.vrf = f.vrf OR f.vrf IN coalesce(a.vrf_leak, [])) AND (b.vrf IS NULL OR b.vrf = f.vrf OR f.vrf IN coalesce(b.vrf_leak, []))))
WITH gds.graph.project($g, a, b, {relationshipProperties: {cost: r.cost}}) AS g
RETURN g.relationshipCount AS rels`;

/** Variant (b): base projection, built ONCE. Carries nid/did on nodes and lid on relationships so a per-flow filter can exclude anything. */
export const PROJECT_BASE = `
MATCH (a:Iface)-[r:LINK|FWD]->(b:Iface)
RETURN gds.graph.project($g, a, b, {
  sourceNodeProperties: {nid: a.nid, did: a.did}, targetNodeProperties: {nid: b.nid, did: b.did},
  relationshipProperties: {cost: r.cost, lid: coalesce(r.id, -1)}}) AS g`;

/** K cheapest paths with a cost budget, pure Cypher: QPP + allReduce on the group variable prunes DURING expansion. */
export const qppQuery = (withLimit = true) => `
MATCH p = (s:Iface {device: $flow.src_host, dir: 'out'})
  ( (a:Iface)-[rels:LINK|FWD]->(b:Iface)
    WHERE type(rels) = 'LINK' OR (${verdict("a", "in", "$flow")} AND ${verdict("b", "out", "$flow")}) )+
  (t:Iface {device: $flow.dst_host, dir: 'in'})
WHERE allReduce(c = 0.0, r IN rels | c + r.cost, c <= $budget)
RETURN reduce(c = 0.0, x IN relationships(p) | c + x.cost) AS cost, [n IN nodes(p) | n.name] AS ifs, [n IN nodes(p) | n.device] AS devs
ORDER BY cost${withLimit ? " LIMIT $k" : ""}`;

/** Prepend a deny ACE (seq 1) for tcp/<port> on the OUT ACL of an interface, in BOTH storages. Creates ACL + permit-any tail when absent. */
export const PLANT_DENY = `
MATCH (i:Iface {name: $name, dir: 'out'})
WITH i, i.out_seqs IS NULL AS fresh
SET i.planted = coalesce(i.planted, fresh),
    i.out_seqs    = [1]      + CASE WHEN fresh THEN [1000]         ELSE i.out_seqs    END,
    i.out_actions = ['deny'] + CASE WHEN fresh THEN ['permit']     ELSE i.out_actions END,
    i.out_protos  = ['tcp']  + CASE WHEN fresh THEN ['ip']         ELSE i.out_protos  END,
    i.out_src_lo  = [0]      + CASE WHEN fresh THEN [0]            ELSE i.out_src_lo  END,
    i.out_src_hi  = [4294967295] + CASE WHEN fresh THEN [4294967295] ELSE i.out_src_hi END,
    i.out_dst_lo  = [0]      + CASE WHEN fresh THEN [0]            ELSE i.out_dst_lo  END,
    i.out_dst_hi  = [4294967295] + CASE WHEN fresh THEN [4294967295] ELSE i.out_dst_hi END,
    i.out_dp_lo   = [$port]  + CASE WHEN fresh THEN [0]            ELSE i.out_dp_lo   END,
    i.out_dp_hi   = [$port]  + CASE WHEN fresh THEN [65535]        ELSE i.out_dp_hi   END
CREATE (i)-[:ACE]->(:Net:Ace {seq: 1, action: 'deny', proto: 'tcp', src_lo: 0, src_hi: 4294967295, dst_lo: 0, dst_hi: 4294967295, dp_lo: $port, dp_hi: $port, planted: true})
WITH i, fresh
CALL (i, fresh) {
  WHEN fresh THEN {
    CREATE (i)-[:ACE]->(:Net:Ace {seq: 1000, action: 'permit', proto: 'ip', src_lo: 0, src_hi: 4294967295, dst_lo: 0, dst_hi: 4294967295, dp_lo: 0, dp_hi: 65535, planted: true})
    RETURN 1 AS made }
  ELSE { RETURN 0 AS made }
}
RETURN i.name AS name`;

/** Undo every planted ACE (scenario 2 / 4 live edits) in both storages. */
export const CLEAR_PLANTED = `
CALL () {
  MATCH (e:Ace {planted: true}) DETACH DELETE e
  RETURN count(*) AS nodesRemoved
}
CALL () {
  MATCH (i:Iface) WHERE i.out_seqs IS NOT NULL AND i.out_seqs[0] = 1
  WITH i, coalesce(i.planted, false) AS whole
  CALL (i, whole) {
    WHEN whole THEN {
      REMOVE i.out_seqs, i.out_actions, i.out_protos, i.out_src_lo, i.out_src_hi, i.out_dst_lo, i.out_dst_hi, i.out_dp_lo, i.out_dp_hi, i.planted
      RETURN 1 AS r }
    ELSE {
      SET i.out_seqs = i.out_seqs[1..], i.out_actions = i.out_actions[1..], i.out_protos = i.out_protos[1..],
          i.out_src_lo = i.out_src_lo[1..], i.out_src_hi = i.out_src_hi[1..], i.out_dst_lo = i.out_dst_lo[1..], i.out_dst_hi = i.out_dst_hi[1..],
          i.out_dp_lo = i.out_dp_lo[1..], i.out_dp_hi = i.out_dp_hi[1..]
      RETURN 1 AS r }
  }
  RETURN count(*) AS listsRestored
}
RETURN nodesRemoved, listsRestored`;
