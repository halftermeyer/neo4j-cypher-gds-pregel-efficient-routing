// Empty the demo data (only :Net nodes and net_* projections) so a recording starts from the honest "empty database" state.
// Usage: npm run reset
import { readFileSync } from "node:fs";
const env: Record<string, string> = {};
for (const l of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) { const m = l.match(/^([A-Z0-9_]+)=(.*)$/); if (m) env[m[1]] = m[2]; }
(globalThis as any).__CFG__ = { uri: env.NEO4J_URI, user: env.NEO4J_USER, password: env.NEO4J_PASSWORD, database: env.NEO4J_DATABASE || "neo4j", batfish: "" };
const { resetDemo, stats } = await import("../src/lib/db.ts");
const { getDriver } = await import("../src/lib/neo4j.ts");
const db = (globalThis as any).__CFG__.database;
await resetDemo(db);
console.log("demo data removed:", JSON.stringify(await stats(db)));
await (await getDriver()).close();
