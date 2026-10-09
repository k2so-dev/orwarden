import { describe, expect, test } from "bun:test";
import { configHash, presetConfig, presetPrice, presetSlugs, rankForPreset, scoreEndpoints, type Profile } from "../src/services/analysis.ts";
import { ep, model } from "./helpers.ts";
import { testConfig } from "./helpers.ts";

describe("preset slugs", () => {
  test("keep the short name when it is unique", () => {
    const slugs = presetSlugs(["deepseek/deepseek-v4", "qwen/qwen3-235b"], testConfig(), new Map());
    expect(slugs.get("deepseek/deepseek-v4")).toBe("deepseek-v4-safe");
    expect(slugs.get("qwen/qwen3-235b")).toBe("qwen3-235b-safe");
  });

  test("include the author when short names collide", () => {
    const slugs = presetSlugs(["a/llama-3-70b", "b/llama-3-70b"], testConfig(), new Map());
    expect(slugs.get("a/llama-3-70b")).toBe("a-llama-3-70b-safe");
    expect(slugs.get("b/llama-3-70b")).toBe("b-llama-3-70b-safe");
  });

  test("keep the slug of a synced preset when a collision appears later", () => {
    const synced = { model: "a/llama", slug: null, autoSync: false, pinned: [], excluded: [], picked: null, overrides: {}, syncedHash: "h", syncedAt: "2026-10-01T00:00:00Z" };
    const slugs = presetSlugs(["a/llama", "b/llama"], testConfig(), new Map([["a/llama", synced]]));
    expect(slugs.get("a/llama")).toBe("llama-safe");
    expect(slugs.get("b/llama")).toBe("b-llama-safe");
  });

  test("legacy synced presets with the same short name stay unique", () => {
    const legacy = (m: string) => ({ model: m, slug: null, autoSync: false, pinned: [], excluded: [], picked: null, overrides: {}, syncedHash: "h", syncedAt: "2026-10-01T00:00:00Z" });
    const slugs = presetSlugs(["a/foo", "b/foo"], testConfig(), new Map([["a/foo", legacy("a/foo")], ["b/foo", legacy("b/foo")]]));
    expect(slugs.get("a/foo")).toBe("foo-safe");
    expect(slugs.get("b/foo")).toBe("b-foo-safe");
  });

  test("keep generated slugs within 63 characters", () => {
    const long = `vendor/${"x".repeat(80)}`;
    const slug = presetSlugs([long, `other/${"x".repeat(80)}`], testConfig(), new Map()).get(long)!;
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
  });

  test("never hand out the same slug twice", () => {
    const slugs = presetSlugs(["a/llama", "b/llama", "x/a-llama"], testConfig(), new Map());
    expect(new Set(slugs.values()).size).toBe(3);
  });

  test("always produce valid slugs and terminate", () => {
    const settings = testConfig();
    const bare = { ...settings, presets: { ...settings.presets, slugPattern: "{model}" } };
    const fixed = { ...settings, presets: { ...settings.presets, slugPattern: "my-preset" } };
    expect(presetSlugs(["x/a"], bare, new Map()).get("x/a")).toBe("preset-a");
    const slugs = presetSlugs(["x/a", "y/b"], fixed, new Map());
    expect(new Set(slugs.values()).size).toBe(2);
    for (const slug of slugs.values()) expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{1,62}$/);
  });

  test("avoid a custom slug taken by another model", () => {
    const custom = { model: "x/other", slug: "llama-safe", autoSync: false, pinned: [], excluded: [], picked: null, overrides: {}, syncedHash: null, syncedAt: null };
    const slugs = presetSlugs(["a/llama", "x/other"], testConfig(), new Map([["x/other", custom]]));
    expect(slugs.get("a/llama")).toBe("a-llama-safe");
    expect(slugs.get("x/other")).toBe("llama-safe");
  });
});

describe("preset membership", () => {
  const settings = testConfig();
  const profile: Profile = { name: "test", h: 0.8, r: 0.05, tools: false, inputPerDay: 1_000_000, estimated: false };
  const m = model(settings, "vendor/model", 1, [ep("a/fp8", 1, 2, 0.1), ep("b/fp8", 1.1, 2, 0.11), ep("c/fp8", 1.3, 2, 0.13)]);
  const scores = scoreEndpoints(m.endpoints, profile, m.endpoints, settings.scoring);
  const pick = (preset: { pinned?: string[]; picked?: string[] | null } = {}, topN = 5) =>
    rankForPreset(m, profile, new Set(), scores, { model: m.slug, slug: null, autoSync: false, pinned: preset.pinned ?? [], excluded: [], picked: preset.picked ?? null, overrides: {}, syncedHash: null, syncedAt: null }, topN, false, "score").map((e) => e.tag);

  test("lists the top N by score without dropping pricier endpoints", () => {
    const wide = model(settings, "vendor/wide", 1, [ep("a/fp8", 1, 2, 0.1), ep("b/fp8", 1.05, 2, 0.105), ep("c/fp8", 3, 2, 0.3), ep("d/fp8", 1.1, 2, 0.11)]);
    const base = scoreEndpoints(wide.endpoints, profile, wide.endpoints, settings.scoring);
    const overall: Record<string, number> = { "c/fp8": 90, "a/fp8": 80, "b/fp8": 70, "d/fp8": 60 };
    const ranked = new Map(wide.endpoints.map((e) => [e, { ...base.get(e)!, overall: overall[e.tag]! }]));
    expect(rankForPreset(wide, profile, new Set(), ranked, undefined, 2, false, "score").map((e) => e.tag)).toEqual(["c/fp8", "a/fp8"]);
    expect(pick().sort()).toEqual(["a/fp8", "b/fp8", "c/fp8"]);
  });

  test("pinned endpoints come first and hand-picked ones replace the ranking", () => {
    expect(pick({ pinned: ["c/fp8"] }, 2)[0]).toBe("c/fp8");
    expect(pick({ picked: ["a/fp8", "c/fp8"] })).toEqual(["a/fp8", "c/fp8"]);
  });

  test("prices the preset at its most expensive member", () => {
    const [a, , c] = m.endpoints;
    expect(presetPrice([a!, c!], 0.8, 0.05)).toBeCloseTo(0.2 * 1.3 + 0.8 * 0.13 + 0.05 * 2, 9);
    expect(presetPrice([], 0.8, 0.05)).toBeNull();
  });
});

describe("preset config", () => {
  test("lists providers in only without an order so sticky routing keeps the cache", () => {
    const m = model(testConfig(), "vendor/model", 1, []);
    const config = presetConfig(m, [{ tag: "a/fp8", quantization: "fp8" }, { tag: "b/fp8", quantization: "fp8" }], { tools: false }, testConfig());
    expect(config.provider.only).toEqual(["a/fp8", "b/fp8"]);
    expect("order" in config.provider).toBe(false);
    expect(config.provider.allow_fallbacks).toBe(true);
  });

  test("drops the quantization filter when an endpoint uses a non-standard name", () => {
    const m = model(testConfig(), "vendor/model", 1, []);
    const standard = presetConfig(m, [{ tag: "a/fp8", quantization: "fp8" }], { tools: false }, testConfig());
    expect(standard.provider.quantizations).toEqual(["int8", "fp8", "fp16", "bf16", "fp32"]);
    const custom = presetConfig(m, [{ tag: "a/fp8", quantization: "fp8" }, { tag: "b/mxfp8", quantization: "mxfp8" }], { tools: false }, testConfig());
    expect(custom.provider.quantizations).toBeUndefined();
    expect(custom.provider.only).toEqual(["a/fp8", "b/mxfp8"]);
  });

  test("hash ignores provider defaults echoed by OpenRouter", () => {
    const local = { model: "m", provider: { order: ["a"], only: ["a"], allow_fallbacks: true } };
    expect(configHash({ ...local, provider: { ...local.provider, data_collection: "allow" } })).toBe(configHash(local));
    expect(configHash({ ...local, provider: { ...local.provider, data_collection: "deny" } })).not.toBe(configHash(local));
  });

  test("hash treats empty remote values as absent", () => {
    const local = { model: "m", provider: { order: ["a"], only: ["a"], allow_fallbacks: true } };
    expect(configHash({ ...local, provider: { ...local.provider, quantizations: [], max_price: {}, sort: "" } })).toBe(configHash(local));
  });

  test("hash sees extra fields edited on OpenRouter", () => {
    const local = { model: "m", provider: { order: ["a"], only: ["a"], allow_fallbacks: true } };
    expect(configHash({ ...local, provider: { ...local.provider, sort: "price" } })).not.toBe(configHash(local));
    expect(configHash({ ...local, provider: { ...local.provider, ignore: ["x"] } })).not.toBe(configHash(local));
    expect(configHash({ ...local, usage: { include: false }, provider: { ...local.provider, max_price: {} } })).toBe(configHash(local));
  });

  test("hash ignores provider defaults added by OpenRouter", () => {
    const local = { model: "m", provider: { order: ["a"], only: ["a"], allow_fallbacks: true, quantizations: ["fp8", "bf16"] } };
    const remote = { model: "m", provider: { order: ["a"], only: ["a"], allow_fallbacks: true, quantizations: ["bf16", "fp8"], require_parameters: false, sort: null } };
    expect(configHash(remote)).toBe(configHash(local));
    expect(configHash({ ...local, provider: { ...local.provider, order: ["b"] } })).not.toBe(configHash(local));
  });
});
