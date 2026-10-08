import { describe, expect, test } from "bun:test";
import { configHash, presetConfig, presetSlugs } from "../src/services/analysis.ts";
import { model } from "./helpers.ts";
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
    const synced = { model: "a/llama", slug: null, autoSync: false, scenario: null, pinned: [], excluded: [], syncedHash: "h", syncedAt: "2026-10-01T00:00:00Z" };
    const slugs = presetSlugs(["a/llama", "b/llama"], testConfig(), new Map([["a/llama", synced]]));
    expect(slugs.get("a/llama")).toBe("llama-safe");
    expect(slugs.get("b/llama")).toBe("b-llama-safe");
  });

  test("legacy synced presets with the same short name stay unique", () => {
    const legacy = (m: string) => ({ model: m, slug: null, autoSync: false, scenario: null, pinned: [], excluded: [], syncedHash: "h", syncedAt: "2026-10-01T00:00:00Z" });
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
    const custom = { model: "x/other", slug: "llama-safe", autoSync: false, scenario: null, pinned: [], excluded: [], syncedHash: null, syncedAt: null };
    const slugs = presetSlugs(["a/llama", "x/other"], testConfig(), new Map([["x/other", custom]]));
    expect(slugs.get("a/llama")).toBe("a-llama-safe");
    expect(slugs.get("x/other")).toBe("llama-safe");
  });
});

describe("preset config", () => {
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
