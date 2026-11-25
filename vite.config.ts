import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// One .env at the repo root feeds both docker compose and the browser app (bolt straight from the browser).
// This is a local demo: the password ends up in the dev bundle, exactly like a bolt URL typed in a browser.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    plugins: [react()],
    define: {
      __CFG__: JSON.stringify({
        uri: env.NEO4J_URI || "bolt://127.0.0.1:7687",
        user: env.NEO4J_USER || "neo4j",
        password: env.NEO4J_PASSWORD || "",
        database: env.NEO4J_DATABASE || "neo4j",
        batfish: env.BATFISH_SIDECAR_URL || "http://127.0.0.1:5005",
      }),
    },
  };
});
