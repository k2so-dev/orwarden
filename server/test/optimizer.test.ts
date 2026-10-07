import { describe, expect, test } from "bun:test";
import { optimize } from "../src/core/optimizer.ts";
import { deepseekModel, ep, model, testConfig } from "./helpers.ts";

describe("classification on DeepSeek V4.1 Flash fixture", () => {
  const config = testConfig();
  const m = deepseekModel(config);
  const byTag = new Map(m.endpoints.map((e) => [e.tag, e]));

  test("dekallm is an output outlier", () => {
    expect(byTag.get("dekallm")!.reasons.some((r) => r.startsWith("output"))).toBe(true);
  });

  test("wafer is a cache outlier", () => {
    expect(byTag.get("wafer")!.reasons.some((r) => r.startsWith("cache"))).toBe(true);
  });

  test("deepinfra is ok", () => {
    expect(byTag.get("deepinfra/fp8")!.cls).toBe("ok");
  });

  test("cache rule is skipped for low cache hit profiles", () => {
    const reasoning = deepseekModel(config, 10, 0, 1);
    const wafer = reasoning.endpoints.find((e) => e.tag === "wafer")!;
    expect(wafer.reasons.some((r) => r.startsWith("cache"))).toBe(false);
  });
});

describe("optimizer", () => {
  test("bans dekallm and wafer without a permanent deny list", () => {
    const config = testConfig({ optimizer: { maxMoves: 100 } });
    const result = optimize([deepseekModel(config)], new Set(), config);
    expect(result.target.has("dekallm")).toBe(true);
    expect(result.target.has("wafer")).toBe(true);
    expect(result.target.has("deepinfra")).toBe(false);
    expect(result.objectiveTarget).toBeLessThan(result.objectiveFixed);
  });

  test("is deterministic", () => {
    const config = testConfig({ optimizer: { maxMoves: 100 } });
    const a = optimize([deepseekModel(config)], new Set(), config);
    const b = optimize([deepseekModel(config)], new Set(), config);
    expect([...a.target]).toEqual([...b.target]);
    expect(a.moves).toEqual(b.moves);
  });

  const others = () => [
    ep("baseten/fp8", 0.3, 1.2, 0.007),
    ep("parasail/fp8", 0.3, 1.2, 0.006),
    ep("venice/fp8", 0.3, 1.2, 0.0075),
  ];
  const twoModels = (config: ReturnType<typeof testConfig>, alphaUsd: number, betaUsd: number) => [
    model(config, "x/alpha", alphaUsd, [ep("deepinfra/fp8", 0.1, 2.4, 0.05), ep("morph/fp8", 0.12, 0.5, 0.003), ...others()]),
    model(config, "y/beta", betaUsd, [ep("morph/fp8", 0.1, 2.4, 0.05), ep("deepinfra/fp8", 0.12, 0.5, 0.003), ...others()]),
  ];

  test("weighs providers by usage: alpha-heavy traffic bans deepinfra", () => {
    const config = testConfig();
    const result = optimize(twoModels(config, 100, 1), new Set(), config);
    expect(result.target.has("deepinfra")).toBe(true);
    expect(result.target.has("morph")).toBe(false);
  });

  test("weighs providers by usage: beta-heavy traffic bans morph", () => {
    const config = testConfig();
    const result = optimize(twoModels(config, 1, 100), new Set(), config);
    expect(result.target.has("morph")).toBe(true);
    expect(result.target.has("deepinfra")).toBe(false);
  });

  test("respects the minimum endpoint constraint", () => {
    const config = testConfig({ optimizer: { minEndpointsPerModel: 2 } });
    const m = model(config, "z/gamma", 10, [
      ep("good/fp8", 0.3, 1.2, 0.006),
      ep("bad/fp8", 0.1, 2.4, 0.05),
      ep("fine/fp8", 0.35, 1.3, 0.007),
    ]);
    const result = optimize([m], new Set(), config);
    expect(result.target.has("good")).toBe(false);
    expect(result.target.has("fine")).toBe(false);
  });
});

describe("output inflation", () => {
  const endpoints = () => [
    ep("scam/fp8", 0.08, 2.4, 0.004),
    ep("a/fp8", 0.3, 1.2, 0.006),
    ep("b/fp8", 0.3, 1.2, 0.006),
    ep("c/fp8", 0.3, 1.2, 0.006),
  ];

  test("cheap input with inflated output is banned even when current output share is low", () => {
    const config = testConfig();
    const result = optimize([model(config, "x/alpha", 10, endpoints(), 0.5, 0.02)], new Set(), config);
    expect(result.target.has("scam")).toBe(true);
  });

  test("without the output floor and penalty the same provider survives", () => {
    const config = testConfig({ optimizer: { minOutRatio: 0, penalties: { outputOutlier: 1, cacheOutlier: 1 } } });
    const result = optimize([model(config, "x/alpha", 10, endpoints(), 0.5, 0.02)], new Set(), config);
    expect(result.target.has("scam")).toBe(false);
  });
});

describe("low quantization", () => {
  const fp4 = { quantization: "fp4" };

  test("bans providers that only serve below the minimum, even when they are cheap", () => {
    const config = testConfig();
    const alpha = model(config, "x/alpha", 10, [
      ep("lowq/fp4", 0.05, 0.2, 0.001, fp4),
      ep("mix/fp4", 0.05, 0.2, 0.001, fp4),
      ep("a/fp8", 0.3, 1.2, 0.006),
      ep("b/fp8", 0.3, 1.2, 0.006),
    ]);
    const beta = model(config, "y/beta", 10, [ep("mix/fp8", 0.3, 1.2, 0.006), ep("a/fp8", 0.3, 1.2, 0.006), ep("b/fp8", 0.3, 1.2, 0.006)]);
    const result = optimize([alpha, beta], new Set(), config);
    expect(result.target.has("lowq")).toBe(true);
    expect(result.moves.filter((m) => m.action === "force").map((m) => m.provider)).toEqual(["lowq"]);
  });

  test("can be disabled", () => {
    const config = testConfig({ filters: { banLowQuantProviders: false }, optimizer: { minImprovement: 1 } });
    const alpha = model(config, "x/alpha", 10, [ep("lowq/fp4", 0.05, 0.2, 0.001, fp4), ep("a/fp8", 0.3, 1.2, 0.006)]);
    expect(optimize([alpha], new Set(), config).target.has("lowq")).toBe(false);
  });

  test("never empties a model served only below the minimum", () => {
    const config = testConfig();
    const alpha = model(config, "x/alpha", 10, [ep("one/fp4", 0.05, 0.2, 0.001, fp4), ep("two/fp4", 0.06, 0.2, 0.001, fp4)]);
    const result = optimize([alpha], new Set(), config);
    expect(result.target.size).toBe(1);
  });

  test("native fp4 models are not penalised for fp4", () => {
    const config = testConfig();
    const oss = model(config, "openai/gpt-oss-20b", 10, [ep("novita/fp4", 0.05, 0.2, 0.001, fp4), ep("x/bf16", 0.1, 0.4, 0.002, { quantization: "bf16" })]);
    expect(oss.endpoints.map((e) => [e.cls, e.quant])).toEqual([
      ["ok", "ok"],
      ["ok", "ok"],
    ]);
  });
});
