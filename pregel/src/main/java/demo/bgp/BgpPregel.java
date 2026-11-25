package demo.bgp;

import org.neo4j.gds.api.DatabaseId;
import org.neo4j.gds.api.Graph;
import org.neo4j.gds.api.nodeproperties.ValueType;
import org.neo4j.gds.beta.pregel.Element;
import org.neo4j.gds.beta.pregel.Messages;
import org.neo4j.gds.beta.pregel.Pregel;
import org.neo4j.gds.beta.pregel.PregelComputation;
import org.neo4j.gds.beta.pregel.PregelConfig;
import org.neo4j.gds.beta.pregel.PregelConfigImpl;
import org.neo4j.gds.beta.pregel.PregelResult;
import org.neo4j.gds.beta.pregel.PregelSchema;
import org.neo4j.gds.beta.pregel.context.ComputeContext;
import org.neo4j.gds.beta.pregel.context.MasterComputeContext;
import org.neo4j.gds.core.concurrency.DefaultPool;
import org.neo4j.gds.core.loading.CatalogRequest;
import org.neo4j.gds.core.loading.GraphStoreCatalog;
import org.neo4j.gds.mem.MemoryEstimateDefinition;
import org.neo4j.gds.mem.MemoryEstimations;
import org.neo4j.gds.progress.tracking.ProgressTracker;
import org.neo4j.gds.termination.TerminationFlag;
import org.neo4j.graphdb.GraphDatabaseService;
import org.neo4j.graphdb.Transaction;
import org.neo4j.procedure.Context;
import org.neo4j.procedure.Description;
import org.neo4j.procedure.Mode;
import org.neo4j.procedure.Name;
import org.neo4j.procedure.Procedure;

import java.util.*;
import java.util.stream.Stream;

/**
 * BGP toy on the GDS Pregel framework (same simplified semantics as bgp_model.py).
 * Pregel provides the BSP supersteps, parallel compute, message-driven activation and termination.
 * GDS Pregel messages are doubles only, so a message is just a "my best routes changed" signal;
 * the routes themselves live in a double-buffered array owned by the computation (cur = previous superstep, next = this one),
 * swapped in masterCompute after every superstep.
 */
public class BgpPregel {

    @Context public GraphDatabaseService db;
    @Context public Transaction tx;

    // ------------------------------------------------------------------ model
    public static final class Entry { public String pfx, comm, act, add; public long lp, med, prep; }
    public static final class Session { public int from, to; public boolean ebgp; public List<Entry> exp, imp; }
    public static final class Router { public String name; public long asn, rid; public List<String> orig = List.of(); public String soo; }
    /** Public class instead of a record: Neo4j loads the procedure class with its own classloader, so nestmate access to private record fields fails. */
    public static final class Route {
        public final String prefix, learned; public final long lp, med, fromRid; public final List<Long> aspath; public final List<String> comms;
        public Route(String prefix, long lp, List<Long> aspath, long med, String learned, long fromRid, List<String> comms) {
            this.prefix = prefix; this.lp = lp; this.aspath = aspath; this.med = med; this.learned = learned; this.fromRid = fromRid; this.comms = comms; }
        @Override public boolean equals(Object o) {
            if (!(o instanceof Route r)) return false;
            return lp == r.lp && med == r.med && fromRid == r.fromRid && prefix.equals(r.prefix) && learned.equals(r.learned) && aspath.equals(r.aspath) && comms.equals(r.comms); }
        @Override public int hashCode() { return Objects.hash(prefix, lp, aspath, med, learned, fromRid, comms); }
    }

    public static final Comparator<Route> BEST = Comparator
        .comparingInt((Route r) -> r.learned.equals("local") ? 0 : 1)
        .thenComparing(r -> -r.lp)
        .thenComparingInt(r -> r.aspath.size())
        .thenComparingLong(r -> r.med)
        .thenComparingInt(r -> switch (r.learned) { case "local" -> 0; case "ebgp" -> 1; default -> 2; })
        .thenComparingLong(r -> r.fromRid);

    public static Integer firstMatch(List<Entry> rm, String prefix, List<String> comms) {
        if (rm == null) return null;
        for (int k = 0; k < rm.size(); k++) {
            Entry e = rm.get(k);
            if ((e.pfx.isEmpty() || e.pfx.equals(prefix)) && (e.comm.isEmpty() || comms.contains(e.comm))) return k;
        }
        return null;
    }

    /** Java twin of bgp_model.transfer(); returns null when the route is dropped. */
    public static Route transfer(Route st, Session s, Router a, Router b) {
        if (!s.ebgp && st.learned.equals("ibgp")) return null;                                  // iBGP split horizon
        Integer ek = firstMatch(s.exp, st.prefix, st.comms);
        if (s.exp != null && (ek == null || !s.exp.get(ek).act.equals("permit"))) return null;  // export route-map
        long p = ek == null ? 0 : s.exp.get(ek).prep;
        List<Long> asp1 = new ArrayList<>();
        if (s.ebgp) for (int i = 0; i <= p; i++) asp1.add(a.asn);
        asp1.addAll(st.aspath);
        List<String> comms1 = new ArrayList<>(st.comms);
        if (ek != null && !s.exp.get(ek).add.isEmpty()) comms1.add(s.exp.get(ek).add);
        long med1 = (ek != null && s.exp.get(ek).med >= 0) ? s.exp.get(ek).med : (s.ebgp ? 0 : st.med);
        long lp1 = s.ebgp ? 100 : st.lp;
        if (s.ebgp && asp1.contains(b.asn)) return null;                                         // AS-path loop
        if (b.soo != null && st.comms.contains("soo:" + b.soo)) return null;                     // SOO
        Integer ik = firstMatch(s.imp, st.prefix, comms1);
        if (s.imp != null && (ik == null || !s.imp.get(ik).act.equals("permit"))) return null;  // import route-map
        long lp2 = (ik != null && s.imp.get(ik).lp >= 0) ? s.imp.get(ik).lp : lp1;
        List<String> comms2 = new ArrayList<>(comms1);
        if (ik != null && !s.imp.get(ik).add.isEmpty()) comms2.add(s.imp.get(ik).add);
        return new Route(st.prefix, lp2, asp1, med1, s.ebgp ? "ebgp" : "ibgp", a.rid, comms2);
    }

    // ------------------------------------------------------------------ Pregel computation
    public static final class Computation implements PregelComputation<PregelConfig> {
        public final Router[] routers; public final List<Session>[] inbound;
        public Map<String, Route>[] cur, next;

        @SuppressWarnings("unchecked")
        public Computation(Router[] routers, List<Session>[] inbound) {
            this.routers = routers; this.inbound = inbound;
            cur = new Map[routers.length]; next = new Map[routers.length];
            for (int i = 0; i < routers.length; i++) { cur[i] = Map.of(); next[i] = Map.of(); }
        }

        @Override public PregelSchema schema(PregelConfig c) { return PregelSchema.from(new Element("changed", ValueType.LONG)); }

        public Map<String, Route> recompute(int v) {
            Map<String, Route> best = new HashMap<>();
            Router r = routers[v];
            for (String p : r.orig) {
                Route loc = new Route(p, 100, List.of(), 0, "local", r.rid, r.soo == null ? List.of() : List.of("soo:" + r.soo));
                best.merge(p, loc, (x, y) -> BEST.compare(x, y) <= 0 ? x : y);
            }
            for (Session s : inbound[v]) {
                for (Route st : cur[s.from].values()) {
                    Route c = transfer(st, s, routers[s.from], r);
                    if (c != null) best.merge(c.prefix, c, (x, y) -> BEST.compare(x, y) <= 0 ? x : y);
                }
            }
            return best;
        }

        @Override public void compute(ComputeContext<PregelConfig> ctx, Messages messages) {
            int v = (int) ctx.nodeId();
            if (ctx.isInitialSuperstep() || !messages.isEmpty()) {     // woken up: some in-neighbour changed its best routes
                Map<String, Route> nb = recompute(v);
                next[v] = nb;
                boolean changed = !nb.equals(cur[v]);
                ctx.setNodeValue("changed", changed ? 1L : 0L);
                if (changed) ctx.sendToNeighbors(1.0);
            }
            ctx.voteToHalt();
        }

        @Override public boolean masterCompute(MasterComputeContext<PregelConfig> ctx) {
            for (int i = 0; i < cur.length; i++) cur[i] = next[i];   // publish this superstep's RIBs for the next one
            return false;
        }

        @Override public MemoryEstimateDefinition estimateDefinition(boolean async) { return MemoryEstimations::empty; }
    }

    // ------------------------------------------------------------------ procedure
    public static final class Row {
        public String router, prefix, learned; public long lp, med, fromRid, iterations; public List<Long> aspath; public List<String> comms;
        public boolean converged;
    }

    @SuppressWarnings("unchecked")
    public static List<Entry> entries(Map<String, Object> r, String side) {
        Object seq = r.get(side + "_seq");
        if (seq == null) return null;
        int n = ((List<?>) seq).size(); List<Entry> out = new ArrayList<>();
        for (int k = 0; k < n; k++) {
            Entry e = new Entry();
            e.pfx = (String) ((List<?>) r.get(side + "_pfx")).get(k); e.comm = (String) ((List<?>) r.get(side + "_comm")).get(k);
            e.act = (String) ((List<?>) r.get(side + "_act")).get(k); e.add = (String) ((List<?>) r.get(side + "_add")).get(k);
            e.lp = ((Number) ((List<?>) r.get(side + "_lp")).get(k)).longValue(); e.med = ((Number) ((List<?>) r.get(side + "_med")).get(k)).longValue();
            e.prep = ((Number) ((List<?>) r.get(side + "_prep")).get(k)).longValue();
            out.add(e);
        }
        return out;
    }

    @Procedure(name = "netdt.bgp.pregel", mode = Mode.READ)
    @Description("BGP best-path fixed point on GDS Pregel over a projected graph of (:Router)-[:BGP]->(:Router).")
    @SuppressWarnings("unchecked")
    public Stream<Row> bgpPregel(@Name("graphName") String graphName,
                                 @Name(value = "maxIterations", defaultValue = "40") long maxIterations,
                                 @Name(value = "concurrency", defaultValue = "4") long concurrency,
                                 @Name(value = "user", defaultValue = "neo4j") String user) {
        Graph graph = GraphStoreCatalog.get(CatalogRequest.of(user, DatabaseId.of(db.databaseName())), graphName).graphStore().getUnion();
        int n = (int) graph.nodeCount();
        Router[] routers = new Router[n];
        List<Session>[] inbound = new List[n];
        for (int i = 0; i < n; i++) inbound[i] = new ArrayList<>();
        tx.execute("MATCH (r:Router) RETURN id(r) AS id, r.name AS name, r.asn AS asn, r.rid AS rid, r.orig AS orig, r.soo AS soo")
          .forEachRemaining(m -> {
              Router r = new Router(); r.name = (String) m.get("name"); r.asn = ((Number) m.get("asn")).longValue();
              r.rid = ((Number) m.get("rid")).longValue(); r.soo = (String) m.get("soo");
              if (m.get("orig") != null) r.orig = Arrays.asList((String[]) m.get("orig"));
              routers[(int) graph.toMappedNodeId((Long) m.get("id"))] = r;
          });
        tx.execute("MATCH (a:Router)-[r:BGP]->(b:Router) RETURN id(a) AS a, id(b) AS b, properties(r) AS p")
          .forEachRemaining(m -> {
              Map<String, Object> p = new HashMap<>((Map<String, Object>) m.get("p"));
              for (var e : p.entrySet()) if (e.getValue() != null && e.getValue().getClass().isArray()) {   // arrays -> lists
                  Object arr = e.getValue(); int len = java.lang.reflect.Array.getLength(arr); List<Object> l = new ArrayList<>();
                  for (int i = 0; i < len; i++) l.add(java.lang.reflect.Array.get(arr, i));
                  e.setValue(l);
              }
              Session s = new Session();
              s.from = (int) graph.toMappedNodeId((Long) m.get("a")); s.to = (int) graph.toMappedNodeId((Long) m.get("b"));
              s.ebgp = "ebgp".equals(p.get("type")); s.exp = entries(p, "exp"); s.imp = entries(p, "imp");
              inbound[s.to].add(s);
          });
        PregelConfig config = new PregelConfigImpl.Builder().maxIterations((int) maxIterations).concurrency((int) concurrency).build();
        Computation comp = new Computation(routers, inbound);
        PregelResult res = Pregel.create(graph, config, comp, DefaultPool.INSTANCE, ProgressTracker.NULL_TRACKER, TerminationFlag.RUNNING_TRUE).run();
        List<Row> rows = new ArrayList<>();
        for (int v = 0; v < n; v++) for (Route r : comp.cur[v].values()) {
            Row row = new Row(); row.router = routers[v].name; row.prefix = r.prefix; row.lp = r.lp; row.aspath = r.aspath; row.med = r.med;
            row.learned = r.learned; row.fromRid = r.fromRid; row.comms = r.comms; row.iterations = res.ranIterations(); row.converged = res.didConverge();
            rows.add(row);
        }
        return rows.stream();
    }
}
