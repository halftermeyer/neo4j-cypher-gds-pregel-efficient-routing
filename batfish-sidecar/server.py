"""Minimal sidecar for scenario 7: POST IOS configs, get Batfish's best BGP routes back as JSON. Standard library + pybatfish only."""
import json, os, shutil, tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pybatfish.client.session import Session

bf = Session(host="localhost")
bf.set_network("netdt")

def best_routes(configs):
    d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "configs"))
    try:
        for name, text in configs.items():
            if "/" in name or ".." in name: raise ValueError("bad file name")
            open(os.path.join(d, "configs", name), "w").write(text)
        bf.init_snapshot(d, name="snap", overwrite=True)
        df = bf.q.bgpRib().answer().frame()
        rows = []
        for _, r in df.iterrows():
            st = r["Status"]
            if "BEST" not in (st if isinstance(st, list) else [st]): continue
            comms = r["Communities"]
            rows.append(dict(node=str(r["Node"]), network=str(r["Network"]), local_pref=int(r["Local_Pref"]), as_path=str(r["AS_Path"]).strip("[]() ").replace(",", " "),
                             metric=int(r["Metric"]), received_from_ip=str(r["Received_From_IP"]),
                             communities=[str(c) for c in (comms if isinstance(comms, (list, tuple, set)) else [comms]) if str(c) not in ("", "None", "nan")]))
        return rows
    finally:
        shutil.rmtree(d, ignore_errors=True)

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        for k, v in (("Content-Type", "application/json"), ("Access-Control-Allow-Origin", "*"), ("Access-Control-Allow-Headers", "content-type"), ("Content-Length", str(len(body)))): self.send_header(k, v)
        self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self): self._send(204, {})
    def do_GET(self):
        if self.path == "/health": self._send(200, {"ok": True})
        else: self._send(404, {"error": "not found"})
    def do_POST(self):
        if self.path != "/bgp-rib": return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", 0))
            self._send(200, {"rows": best_routes(json.loads(self.rfile.read(n))["configs"])})
        except Exception as e:
            self._send(500, {"error": str(e)})

if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 5005), H).serve_forever()
