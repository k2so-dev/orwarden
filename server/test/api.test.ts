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

  test("dry-run apply returns the diff without writing", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/providers/dekallm/policy", { method: "PUT", body: { policy: "ban" } });
    const plan = await ctx.call("/api/bans/apply", { method: "POST", body: { dryRun: true } });
    expect(plan.body.dryRun).toBe(true);
    expect(plan.body.added).toEqual(["dekallm"]);
    expect(plan.body.cost.before).toBeGreaterThan(0);
    expect(plan.body.cost.after).not.toBeNull();
    expect(ctx.mock.calls.patches).toEqual([]);
    const discard = await ctx.call("/api/bans/discard", { method: "POST" });
    expect(discard.status).toBe(200);
    expect(ctx.store.policies().get("dekallm")).toBeUndefined();
    const sync = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK], dryRun: true } });
    expect(sync.body[0].status).toBe("planned");
    expect(ctx.mock.calls.presets).toEqual([]);
  });

  test("status reports health and next run", async () => {
    const before = await ctx.call("/api/status");
    expect(before.body.health).toBe("ok");
    expect(before.body.nextRunAt).toBe("2026-10-07T13:00:00.000Z");
    ctx.rt.deleteKey();
    expect((await ctx.call("/api/status")).body.health).toBe("no-key");
  });

  test("history entries carry a source and catalog carries usage", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/providers/dekallm/policy", { method: "PUT", body: { policy: "ban" } });
    await ctx.call("/api/bans/apply", { method: "POST", body: {} });
    const history = await ctx.call("/api/bans/history");
    expect(history.body[0].source).toBe("manual");
    const catalog = await ctx.call("/api/catalog?q=deepseek");
    expect(catalog.body[0].usageUsd).toBeGreaterThan(0);
  });

  test("scheduled refresh in dry-run never patches", async () => {
    await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(ctx.mock.calls.patches).toEqual([]);
    expect(ctx.store.loadStates().size).toBeGreaterThan(0);
  });

  test("scheduled auto-sync in dry-run never writes presets", async () => {
    await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, autoSync: true } });
    const run = await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(run.presets.map((p) => p.status)).toEqual(["planned"]);
    expect(ctx.mock.calls.presets).toEqual([]);
  });

  test("presets are built, synced and reported up to date", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    const before = await ctx.call("/api/presets");
    const p = before.body.find((x: any) => x.model === DEEPSEEK);
    expect(p.status).toBe("not-created");
    expect(p.config.provider.only.length).toBeLessThanOrEqual(5);
    expect(p.config.provider.quantizations).not.toContain("fp4");
    expect(p.ranked[0].pIn).toBeGreaterThan(0);
    expect(p.ranked.reduce((a: number, e: any) => a + e.share, 0)).toBeCloseTo(1, 5);
    expect(p.perM.preset).toBeGreaterThan(0);
    expect(p.scenarios.map((s: any) => s.name)).toContain("agent");
    expect(p.cheapest.costPerM).toBeLessThanOrEqual(p.ranked[0].costPerM);
    const sync = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    expect(sync.body[0].status).toBe("synced");
    expect(ctx.mock.calls.presets[0]!.slug).toBe(p.slug);
    const after = await ctx.call("/api/presets?fresh=true");
    expect(after.body.find((x: any) => x.model === DEEPSEEK).status).toBe("up-to-date");
  });

  test("presets ignore view filters and match the overview ranking", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    const base = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK);
    const view = "scenario=agent&minQuantization=fp4&wPrice=0&wSpeed=100&wReliability=0&zdrOnly=true";
    const skewed = (await ctx.call(`/api/presets?${view}`)).body.find((x: any) => x.model === DEEPSEEK);
    expect(skewed.hash).toBe(base.hash);
    const overview = (await ctx.call(`/api/overview?${view}`)).body.models.find((x: any) => x.slug === DEEPSEEK);
    const ranks = overview.endpoints.filter((e: any) => e.presetRank !== null).sort((a: any, b: any) => a.presetRank - b.presetRank);
    expect(ranks.map((e: any) => e.tag)).toEqual(base.ranked.map((e: any) => e.tag));
    expect(overview.presetId).toBe(base.presetId);
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK], view: { scenario: "agent", minQuantization: "fp4" } } });
    expect(ctx.mock.calls.presets[0]!.config).toEqual(base.config);
  });

  test("presets and views follow the saved workload and filters", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    const base = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK);
    expect(base.profile.name).toBe("actual");
    expect(base.config.provider.require_parameters).toBeUndefined();
    await ctx.call("/api/settings", {
      method: "PUT",
      body: { workload: { mode: "custom", h: 0.2, r: 1, tokensPerDay: 5_000_000 }, filters: { requireTools: true } },
    });
    const next = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK);
    expect(next.profile).toMatchObject({ name: "custom", h: 0.2, r: 1, tools: true, inputPerDay: 5_000_000 });
    expect(next.config.provider.require_parameters).toBe(true);
    expect(next.hash).not.toBe(base.hash);
    const overview = (await ctx.call("/api/overview")).body.models.find((x: any) => x.slug === DEEPSEEK);
    expect(overview.profile).toMatchObject({ name: "custom", h: 0.2, r: 1, tools: true });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    expect(ctx.mock.calls.presets[0]!.config).toEqual(next.config);
  });

  test("a legacy default scenario becomes the saved workload", async () => {
    ctx.store.setValue("settings", { presets: { defaultScenario: "agent" } });
    const s = new Runtime({ env, store: ctx.store, vault: ctx.rt.vault, clientFactory: () => ctx.mock.client, now: NOW }).settings();
    expect(s.workload).toMatchObject({ mode: "custom", h: 0.8, r: 0.05 });
    expect(s.filters.requireTools).toBe(true);
  });

  test("a hand-picked preset contains exactly the picked endpoints", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    const base = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK);
    expect(base.picked).toBeNull();
    const tag = base.ranked[base.ranked.length - 1].tag;
    await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, picked: [tag] } });
    const picked = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK);
    expect(picked.picked).toEqual([tag]);
    expect(picked.ranked.map((e: any) => e.tag)).toEqual([tag]);
    expect(picked.ranked[0].picked).toBe(true);
    await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, picked: null } });
    const reset = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK);
    expect(reset.hash).toBe(base.hash);
  });

  test("preset status follows the remote config", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const p = (await ctx.call("/api/presets?fresh=true")).body.find((x: any) => x.model === DEEPSEEK);
    expect(p.status).toBe("up-to-date");
    const remote = ctx.mock.presets.get(p.slug)!.designated_version!.config as any;
    remote.provider.order = [...remote.provider.order].reverse();
    const changed = (await ctx.call("/api/presets?fresh=true")).body.find((x: any) => x.model === DEEPSEEK);
    expect(changed.status).toBe("out-of-date");
  });

  test("auto-sync adopts a remote preset that already matches", async () => {
    await ctx.call("/api/settings", { method: "PUT", body: { mode: "apply" } });
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const saved = ctx.store.presetSettings().get(DEEPSEEK)!;
    expect(saved.slug).toBe("deepseek-v4-1-flash-safe");
    ctx.store.savePresetSettings({ ...saved, autoSync: true, syncedHash: "legacy-hash" });
    const writes = ctx.mock.calls.presets.length;
    const run = await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(run.presets.map((p) => p.status)).toEqual(["skipped"]);
    expect(ctx.mock.calls.presets.length).toBe(writes);
    expect(ctx.store.presetSettings().get(DEEPSEEK)!.syncedHash).not.toBe("legacy-hash");
  });

  test("slugs of untracked models stay reserved and own slugs stay editable", async () => {
    ctx.store.savePresetSettings({ model: "gone/model", slug: "foo-safe", autoSync: false, pinned: [], excluded: [], picked: null, syncedHash: null, syncedAt: null });
    const clash = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, slug: "foo-safe" } });
    expect(clash.status).toBe(409);
    const own = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: "gone/model", autoSync: true } });
    expect(own.status).toBe(200);
  });

  test("auto-sync recreates a preset deleted on OpenRouter", async () => {
    await ctx.call("/api/settings", { method: "PUT", body: { mode: "apply" } });
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, autoSync: true } });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const slug = ctx.mock.calls.presets[0]!.slug;
    ctx.mock.presets.delete(slug);
    (await import("../src/services/presets.ts")).clearRemoteCache();
    const run = await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(run.presets.map((p) => p.status)).toEqual(["synced"]);
    expect(ctx.mock.presets.has(slug)).toBe(true);
  });

  test("auto-sync does not rewrite a preset whose remote config is unreadable", async () => {
    await ctx.call("/api/settings", { method: "PUT", body: { mode: "apply" } });
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, autoSync: true } });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const slug = ctx.mock.calls.presets[0]!.slug;
    const remote = ctx.mock.presets.get(slug)!;
    ctx.mock.presets.set(slug, { ...remote, designated_version: undefined });
    (await import("../src/services/presets.ts")).clearRemoteCache();
    const writes = ctx.mock.calls.presets.length;
    const run = await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(run.presets.map((p) => p.status)).toEqual(["skipped"]);
    expect(ctx.mock.calls.presets.length).toBe(writes);
  });

  test("a remote preset for another model under a free slug is foreign", async () => {
    await ctx.call("/api/settings", { method: "PUT", body: { mode: "apply" } });
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    const slug = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK).slug;
    ctx.mock.presets.set(slug, { id: slug, slug, name: slug, designated_version: { version: 1, config: { model: "other/model", provider: { order: ["x"] } } as any } });
    (await import("../src/services/presets.ts")).clearRemoteCache();
    const p = (await ctx.call("/api/presets?fresh=true")).body.find((x: any) => x.model === DEEPSEEK);
    expect(p.status).toBe("foreign");
    await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, autoSync: true } });
    const writes = ctx.mock.calls.presets.length;
    const run = await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(run.presets.map((r) => r.status)).toEqual(["failed"]);
    expect(ctx.mock.calls.presets.length).toBe(writes);
  });

  test("manual sync overwrites a foreign preset only when asked", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    const slug = (await ctx.call("/api/presets")).body.find((x: any) => x.model === DEEPSEEK).slug;
    ctx.mock.presets.set(slug, { id: slug, slug, name: slug, designated_version: { version: 1, config: { model: "other/model", provider: { order: ["x"] } } as any } });
    const blocked = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    expect(blocked.body.map((r: any) => r.status)).toEqual(["failed"]);
    const wrongConsent = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK], accept: ["unknown", "edits"] } });
    expect(wrongConsent.body.map((r: any) => r.status)).toEqual(["failed"]);
    const forced = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK], accept: ["foreign"] } });
    expect(forced.body.map((r: any) => r.status)).toEqual(["synced"]);
    expect((ctx.mock.presets.get(slug)!.designated_version!.config as any).model).toBe(DEEPSEEK);
  });

  test("slug pattern must produce valid slugs", async () => {
    const bad = await ctx.call("/api/settings", { method: "PUT", body: { presets: { slugPattern: "{model}_Safe" } } });
    expect(bad.status).toBe(400);
    const bare = await ctx.call("/api/settings", { method: "PUT", body: { presets: { slugPattern: "{model}" } } });
    expect(bare.status).toBe(200);
  });

  test("auto-sync keeps privacy edits made on OpenRouter", async () => {
    await ctx.call("/api/settings", { method: "PUT", body: { mode: "apply" } });
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, autoSync: true } });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const slug = ctx.mock.calls.presets[0]!.slug;
    (ctx.mock.presets.get(slug)!.designated_version!.config as any).provider.zdr = true;
    const writes = ctx.mock.calls.presets.length;
    const run = await ctx.rt.exclusive(() => import("../src/services/refresh.ts").then((m) => m.refresh(ctx.rt, true)));
    expect(run.presets.map((r) => r.status)).toEqual(["failed"]);
    expect(ctx.mock.calls.presets.length).toBe(writes);
  });

  test("manual sync does not drop a system prompt set on OpenRouter unless asked", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const slug = ctx.mock.calls.presets[0]!.slug;
    ctx.mock.presets.get(slug)!.designated_version!.system_prompt = "Be brief";
    const blocked = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    expect(blocked.body[0].status).toBe("failed");
    expect(blocked.body[0].error).toContain("system_prompt");
    const forced = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK], accept: ["edits"] } });
    expect(forced.body[0].status).toBe("synced");
  });

  test("manual sync refuses to write blind or to an unexpected slug", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const slug = ctx.mock.calls.presets[0]!.slug;
    const moved = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK], slugs: { [DEEPSEEK]: "old-slug" } } });
    expect(moved.body[0].status).toBe("failed");
    const getPreset = ctx.mock.client.getPreset;
    ctx.mock.client.getPreset = async () => {
      throw new Error("unreachable");
    };
    const writes = ctx.mock.calls.presets.length;
    const blind = await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK], slugs: { [DEEPSEEK]: slug } } });
    expect(blind.body[0].status).toBe("failed");
    expect(ctx.mock.calls.presets.length).toBe(writes);
    ctx.mock.client.getPreset = getPreset;
  });

  test("renaming a synced preset resets its sync state", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const renamed = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, slug: "my-ds" } });
    expect(renamed.body.syncedHash).toBeNull();
    const p = (await ctx.call("/api/presets?fresh=true")).body.find((x: any) => x.model === DEEPSEEK);
    expect(p.status).toBe("not-created");
  });

  test("custom slugs cannot take a pinned slug", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/presets/sync", { method: "POST", body: { models: [DEEPSEEK] } });
    const clash = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: "other/model", slug: "deepseek-v4-1-flash-safe" } });
    expect(clash.status).toBe(409);
  });

  test("preset settings validate slugs", async () => {
    const bad = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, slug: "Bad Slug" } });
    expect(bad.status).toBe(400);
    const good = await ctx.call("/api/presets/settings", { method: "PUT", body: { model: DEEPSEEK, slug: "flash", autoSync: true } });
    expect(good.body.slug).toBe("flash");
  });

  test("presets can rank by effective cost", async () => {
    await ctx.call("/api/refresh", { method: "POST", body: {} });
    await ctx.call("/api/settings", { method: "PUT", body: { presets: { rankBy: "cost" } } });
    const { body } = await ctx.call("/api/presets");
    const ranked = body.find((x: any) => x.model === DEEPSEEK).ranked;
    for (let i = 1; i < ranked.length; i++) expect(ranked[i].effectivePerM).toBeGreaterThanOrEqual(ranked[i - 1].effectivePerM);
  });

  test("settings are validated and persisted", async () => {
    const bad = await ctx.call("/api/settings", { method: "PUT", body: { filters: { minUptime: 5 } } });
    expect(bad.status).toBe(400);
    const good = await ctx.call("/api/settings", { method: "PUT", body: { presets: { topN: 3 } } });
    expect(good.body.presets.topN).toBe(3);
    expect(good.body.presets.slugPattern).toBe("{model}-safe");
  });
});
