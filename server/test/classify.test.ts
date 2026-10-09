import { describe, expect, test } from "bun:test";
import { violations } from "../src/core/coverage.ts";
import { classifyModel } from "../src/core/classify.ts";
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

  test("closed models are not judged by quantization", () => {
    const eps = [ep("alpha", 1, 2, 0.5, { quantization: "unknown" }), ep("beta", 1, 2, 0.5, { quantization: "unknown" })];
    const closed = classifyModel({ slug: "openai/gpt-x", name: "x", usageUsd: 1, inputTokens: 0, h: 0, r: 1, source: "usage", openWeights: false, endpoints: eps }, config);
    expect(closed.endpoints.every((e) => e.cls === "ok" && e.quant === "closed")).toBe(true);
    const open = classifyModel({ slug: "vendor/open-x", name: "x", usageUsd: 1, inputTokens: 0, h: 0, r: 1, source: "usage", endpoints: eps }, config);
    expect(open.endpoints.every((e) => e.cls === "hard-bad")).toBe(true);
  });

  test("output above the hard threshold is hard-bad", () => {
    const m = model(config, "vendor/m", 1, [ep("a", 1, 2, 0.5), ep("b", 1, 2, 0.5), ep("c", 1, 2.2, 0.5), ep("d", 1, 6, 0.5)], 0, 1);
    const byTag = new Map(m.endpoints.map((e) => [e.tag, e]));
    expect(byTag.get("d")!.cls).toBe("hard-bad");
    expect(byTag.get("d")!.issues[0]!.level).toBe("bad");
    expect(byTag.get("c")!.cls).toBe("ok");
  });

  test("cache rule is skipped for low cache hit profiles", () => {
    const reasoning = deepseekModel(config, 10, 0, 1);
    const wafer = reasoning.endpoints.find((e) => e.tag === "wafer")!;
    expect(wafer.reasons.some((r) => r.startsWith("cache"))).toBe(false);
  });
});

describe("low quantization", () => {
  const fp4 = { quantization: "fp4" };

  test("native fp4 models are not penalised for fp4", () => {
    const config = testConfig();
    const oss = model(config, "openai/gpt-oss-20b", 10, [ep("novita/fp4", 0.05, 0.2, 0.001, fp4), ep("x/bf16", 0.1, 0.4, 0.002, { quantization: "bf16" })]);
    expect(oss.endpoints.map((e) => [e.cls, e.quant])).toEqual([
      ["ok", "ok"],
      ["ok", "ok"],
    ]);
  });
});

describe("coverage", () => {
  const config = testConfig();
  const m = model(config, "z/gamma", 10, [ep("good/fp8", 0.3, 1.2, 0.006), ep("bad/fp8", 0.1, 2.4, 0.05), ep("fine/fp8", 0.35, 1.3, 0.007)]);

  test("flags a model that keeps fewer good endpoints than required", () => {
    const found = violations([m], new Set(), new Set(["good"]), 2);
    expect(found.map((v) => v.slug)).toEqual(["z/gamma"]);
  });

  test("passes when enough good endpoints remain", () => {
    expect(violations([m], new Set(), new Set(), 2)).toEqual([]);
  });

  test("flags a model left with no endpoint at all", () => {
    expect(violations([m], new Set(), new Set(["good", "bad", "fine"]), 1).length).toBe(1);
  });
});
