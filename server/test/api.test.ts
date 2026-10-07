import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app.ts";
import { Store } from "../src/db.ts";
import type { Env } from "../src/env.ts";
import { Runtime } from "../src/services/state.ts";
import { Vault } from "../src/vault.ts";
import { DEEPSEEK, NOW, mockClient } from "./helpers.ts";

const PASSWORD = "correct horse battery";
const KEY = "sk-or-v1-test-management-key";

const env: Env = {
  port: 0,
  password: PASSWORD,
  dataDir: ":memory:",
  refreshCron: "0 * * * *",
  envKey: null,
  baseUrl: "http://openrouter.test",
  webDist: "/nonexistent",
  secureCookies: false,
};

type Mock = ReturnType<typeof mockClient>;

async function setup(ignored = ["relace"]) {
  const store = new Store(":memory:");
  const vault = await Vault.open(PASSWORD, store);
  const mock: Mock = mockClient({ ignored });
  const rt = new Runtime({ env, store, vault, clientFactory: () => mock.client, now: NOW });
  const app = createApp(rt);
  const login = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const call = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const res = await app.request(path, {
      method: init.method ?? "GET",
      headers: { cookie, "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, rt, store, mock, call };
}

describe("auth", () => {
  test("rejects requests without a session", async () => {
    const { app } = await setup();
    expect((await app.request("/api/status")).status).toBe(401);
  });

  test("rejects a wrong password and rate limits", async () => {
    const { app } = await setup();
    const attempt = () =>
      app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: "nope" }) });
    for (let i = 0; i < 5; i++) expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(429);
  });

  test("session cookie grants access", async () => {
    const { call } = await setup();
    const res = await call("/api/auth/session");
    expect(res.body.authenticated).toBe(true);
    expect((await call("/api/status")).status).toBe(200);
  });
});

describe("api flow", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    await ctx.call("/api/key", { method: "PUT", body: { key: KEY } });
  });

  test("stores the key encrypted", async () => {
    const raw = JSON.stringify(ctx.store.db.query("select * from secrets").all());
    expect(raw).not.toContain(KEY);
    expect((await ctx.call("/api/status")).body.key.source).toBe("dashboard");
  });

  test("reports missing data before the first refresh", async () => {
    const res = await ctx.call("/api/overview");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no-data");
  });

  test("refresh builds the overview and imports current bans as policies", async () => {
    expect((await ctx.call("/api/refresh", { method: "POST", body: {} })).status).toBe(200);
    expect(ctx.store.policies().get("relace")).toBe("ban");
    const { body } = await ctx.call("/api/overview?scenario=agent");
    const m = body.models.find((x: any) => x.slug === DEEPSEEK);
    expect(m.endpoints.length).toBeGreaterThan(3);
    expect(m.presetId).toBe("@preset/deepseek-v4-1-flash-safe");
    expect(m.cost.default).toBeGreaterThan(0);
    const ranked = m.endpoints.filter((e: any) => e.presetRank !== null);
    expect(ranked.length).toBeLessThanOrEqual(5);
    expect(ranked.every((e: any) => e.verdict === "ok" && e.tools)).toBe(true);
    expect(m.scenarios.map((s: any) => s.name)).toContain("reasoning");
  });

  test("manual ban policy is applied and can be rolled back", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/providers/dekallm/policy", { method: "PUT", body: { policy: "ban" } });
    const providers = await ctx.call("/api/providers");
    expect(providers.body.pending.added).toEqual(["dekallm"]);
    const applied = await ctx.call("/api/bans/apply", { method: "POST", body: {} });
    expect(applied.body.patched).toBe(true);
    expect(ctx.mock.guardrail.ignored_providers).toEqual(["dekallm", "relace"]);
    const back = await ctx.call("/api/bans/rollback", { method: "POST", body: {} });
    expect(back.body.to).toEqual(["relace"]);
    expect(ctx.mock.guardrail.ignored_providers).toEqual(["relace"]);
    expect(ctx.store.policies().get("dekallm")).toBeUndefined();
    const history = await ctx.call("/api/bans/history");
    expect(history.body.map((r: any) => r.kind)).toEqual(["rollback", "apply", "refresh"]);
  });

  test("scheduled refresh in dry-run never patches", async () => {
    await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(ctx.mock.calls.patches).toEqual([]);
    expect(ctx.store.loadStates().size).toBeGreaterThan(0);
  });

  test("presets are built, synced and reported up to date", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    const before = await ctx.call("/api/presets");
    const p = before.body.find((x: any) => x.model === DEEPSEEK);
    expect(p.status).toBe("not-created");
    expect(p.config.provider.only.length).toBeLessThanOrEqual(5);
    expect(p.config.provider.quantizations).not.toContain("fp4");
    const sync = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    expect(sync.body[0].status).toBe("synced");
    expect(ctx.mock.calls.presets[0]!.slug).toBe(p.slug);
    const after = await ctx.call("/api/presets?fresh=true");
    expect(after.body.find((x: any) => x.model === DEEPSEEK).status).toBe("up-to-date");
  });

  test("preset settings validate slugs", async () => {
    const bad = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, slug: "Bad Slug" } });
    expect(bad.status).toBe(400);
    const good = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, slug: "flash", autoSync: true } });
    expect(good.body.slug).toBe("flash");
  });

  test("settings are validated and persisted", async () => {
    const bad = await ctx.call("/api/settings", { method: "PUT", body: { filters: { minUptime: 5 } } });
    expect(bad.status).toBe(400);
    const good = await ctx.call("/api/settings", { method: "PUT", body: { presets: { topN: 3 } } });
    expect(good.body.presets.topN).toBe(3);
    expect(good.body.presets.slugPattern).toBe("{model}-safe");
  });
});
