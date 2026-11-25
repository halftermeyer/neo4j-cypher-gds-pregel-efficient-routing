// Reset and ingestion, triggered from the app (no separate seed script): the empty database is part of the story.
import { runQuery, withGroup, getDriver } from "./neo4j";
import { generateTopology, type Topology, type TopoOpts } from "./topology";
import { routerRows, sessionRows, type Net } from "./bgp";

export interface DbStats { devices: number; ifaces: number; links: number; fwd: number; aclIfaces: number; aces: number; aceNodes: number; routers: number; sessions: number; routes: number; gdsGraphs: string[] }

export async function ensureDatabase(db: string) {
  if (db === "neo4j") return;
  await runQuery("CREATE DATABASE $db IF NOT EXISTS WAIT 60 SECONDS", { db }, { database: "system" });
}

async function chunked(db: string, cypher: string, rows: unknown[], size: number, key = "rows") {
  for (let i = 0; i < rows.length; i += size) await runQuery(cypher, { [key]: rows.slice(i, i + size) }, { database: db });
}

export async function dropGdsGraphs(db: string, prefix = "") {
  const gs = await runQuery<{ graphName: string }>("CALL gds.graph.list() YIELD graphName, database WHERE database = $db AND graphName STARTS WITH $p RETURN graphName", { db, p: prefix }, { database: db });
  for (const g of gs) await runQuery("CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName", { g: g.graphName }, { database: db });
}

/** Remove everything this demo owns (label :Net) and its in-memory projections. Never touches foreign data. */
export async function resetDemo(db: string) {
  await withGroup("Reset demo data", async () => {
    await dropGdsGraphs(db);
    await runQuery("MATCH (n:Net) CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS", {}, { database: db });
  });
}

export async function ingestTopology(db: string, topo: Topology) {
  await withGroup("Ingest topology", async () => {
    for (const q of [
      "CREATE INDEX net_dev_name IF NOT EXISTS FOR (n:Device) ON (n.name)",
      "CREATE INDEX net_if_name IF NOT EXISTS FOR (n:Iface) ON (n.name)",
      "CREATE INDEX net_if_dev IF NOT EXISTS FOR (n:Iface) ON (n.device)",
      "CREATE INDEX net_router_name IF NOT EXISTS FOR (n:Router) ON (n.name)",
    ]) await runQuery(q, {}, { database: db });
    await chunked(db, "UNWIND $rows AS x CREATE (n:Net:Device) SET n = x", topo.devices, 1000);
    await chunked(db, "UNWIND $rows AS x CREATE (n:Net:Iface) SET n = x", topo.ifaces, 500);
    await runQuery("MATCH (d:Device), (i:Iface {device: d.name}) CREATE (d)-[:HAS_IF]->(i)", {}, { database: db });
    await chunked(db, `UNWIND $rows AS x
      MATCH (ao:Iface {name: x.a + ':out'}), (ai:Iface {name: x.a + ':in'}), (bo:Iface {name: x.b + ':out'}), (bi:Iface {name: x.b + ':in'})
      CREATE (ao)-[:LINK {id: x.id, cost: x.cost}]->(bi), (bo)-[:LINK {id: x.id, cost: x.cost}]->(ai)`, topo.links.map((l) => ({ ...l, cost: l.cost + 0.0 })), 1000);
    await runQuery(`MATCH (d:Device)-[:HAS_IF]->(x:Iface {dir: 'in'}), (d)-[:HAS_IF]->(y:Iface {dir: 'out'})
                    WHERE x.ifname <> y.ifname CREATE (x)-[:FWD {cost: 1.0}]->(y)`, {}, { database: db });
    // The same ACLs, stored a second way: ACE nodes ordered by sequence number
    const aceRows: Record<string, unknown>[] = [];
    for (const i of topo.ifaces) {
      const d = i.dir;
      const seqs = i[`${d}_seqs`] as number[] | undefined;
      if (!seqs) continue;
      seqs.forEach((_, k) => aceRows.push({
        iface: i.name, seq: seqs[k], action: (i[`${d}_actions`] as string[])[k], proto: (i[`${d}_protos`] as string[])[k],
        src_lo: (i[`${d}_src_lo`] as number[])[k], src_hi: (i[`${d}_src_hi`] as number[])[k], dst_lo: (i[`${d}_dst_lo`] as number[])[k], dst_hi: (i[`${d}_dst_hi`] as number[])[k],
        dp_lo: (i[`${d}_dp_lo`] as number[])[k], dp_hi: (i[`${d}_dp_hi`] as number[])[k],
      }));
    }
    await chunked(db, `UNWIND $rows AS x MATCH (i:Iface {name: x.iface})
      CREATE (i)-[:ACE]->(e:Net:Ace) SET e += x, e.iface = null`, aceRows, 1000);
  });
}

export async function ingestBgp(db: string, net: Net) {
  await withGroup("Ingest BGP network", async () => {
    await runQuery("MATCH (n:Router) DETACH DELETE n", {}, { database: db });
    await runQuery("MATCH (n:Route) DETACH DELETE n", {}, { database: db });
    await runQuery("UNWIND $rows AS x CREATE (n:Net:Router) SET n = x", { rows: routerRows(net.R) }, { database: db });
    await chunked(db, "UNWIND $rows AS x MATCH (a:Router {name: x.a}), (b:Router {name: x.b}) CREATE (a)-[r:BGP]->(b) SET r = x.p", sessionRows(net.S), 500);
  });
}

export async function ingestAll(db: string, opts: TopoOpts, net: Net) {
  const topo = generateTopology(opts);
  await ingestTopology(db, topo);
  await ingestBgp(db, net);
  return topo;
}

export async function stats(db: string): Promise<DbStats> {
  const r = await runQuery<Record<string, number>>(`
    CALL () { MATCH (d:Device) RETURN count(d) AS devices }
    CALL () { MATCH (i:Iface) RETURN count(i) AS ifaces,
              sum(CASE WHEN i.in_seqs IS NOT NULL OR i.out_seqs IS NOT NULL THEN 1 ELSE 0 END) AS aclIfaces,
              sum(size(coalesce(i.in_seqs, [])) + size(coalesce(i.out_seqs, []))) AS aces }
    CALL () { MATCH (:Iface)-[l:LINK]->(:Iface) RETURN count(l) AS links }
    CALL () { MATCH (:Iface)-[f:FWD]->(:Iface) RETURN count(f) AS fwd }
    CALL () { MATCH (e:Ace) RETURN count(e) AS aceNodes }
    CALL () { MATCH (x:Router) RETURN count(x) AS routers }
    CALL () { MATCH (:Router)-[s:BGP]->(:Router) RETURN count(s) AS sessions }
    CALL () { MATCH (x:Route) RETURN count(x) AS routes }
    RETURN *`, {}, { database: db, silent: true });
  const g = await runQuery<{ graphName: string }>("CALL gds.graph.list() YIELD graphName, database WHERE database = $db RETURN graphName", { db }, { database: db, silent: true });
  return { ...(r[0] as unknown as DbStats), gdsGraphs: g.map((x) => x.graphName) };
}

export async function checkConnection(): Promise<{ ok: boolean; message: string; gds?: string; pregel?: boolean; edition?: string }> {
  try {
    await getDriver().verifyConnectivity();
    const r = await runQuery<{ gds: string }>("CALL gds.version() YIELD gdsVersion AS gds RETURN gds", {}, { silent: true }).catch(() => []);
    const p = await runQuery<{ n: string }>("SHOW PROCEDURES YIELD name WHERE name = 'netdt.bgp.pregel' RETURN name AS n", {}, { silent: true }).catch(() => []);
    return { ok: true, message: "connected", gds: r[0]?.gds, pregel: p.length > 0 };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
