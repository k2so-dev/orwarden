import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createApp } from "./app.ts";
import { Store } from "./db.ts";
import { readEnv } from "./env.ts";
import { refresh } from "./services/refresh.ts";
import { Runtime } from "./services/state.ts";
import { Vault } from "./vault.ts";

const env = readEnv();
const store = new Store(join(env.dataDir, "rerouter.db"));
const vault = await Vault.open(env.password, store);
const rt = new Runtime({ env, store, vault });

const server = new Hono()
  .route("/", createApp(rt))
  .use("/assets/*", serveStatic({ root: env.webDist }))
  .use("*", serveStatic({ root: env.webDist }))
  .get("*", async (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "not-found", message: "Not found", details: null }, 404);
    const index = Bun.file(join(env.webDist, "index.html"));
    return (await index.exists()) ? c.html(await index.text()) : c.text("Frontend is not built", 503);
  });

rt.startScheduler(async () => {
  await rt.exclusive(() => refresh(rt, true));
});

Bun.serve({ port: env.port, fetch: server.fetch });
console.log(`rerouter listening on :${env.port}, refresh cron "${rt.settings().refreshCron}"`);

if (!rt.snapshot() && (await rt.keySource())) {
  rt.exclusive(() => refresh(rt, false)).catch((err) => console.error(`initial refresh failed: ${err instanceof Error ? err.message : err}`));
}
