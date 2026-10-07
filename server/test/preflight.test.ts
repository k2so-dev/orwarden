import { describe, expect, test } from "bun:test";
import { violations } from "../src/core/optimizer.ts";
import { preflight } from "../src/core/preflight.ts";
import { ep, model, testConfig } from "./helpers.ts";

describe("preflight", () => {
  const config = testConfig();
  const alpha = model(config, "x/alpha", 10, [
    ep("one/fp8", 0.3, 1.2, 0.006),
    ep("two/fp8", 0.3, 1.2, 0.006),
    ep("three", 0.1, 0.5, 0.002, { quantization: "unknown" }),
  ]);
  const beta = model(config, "y/beta", 10, [
    ep("one/fp8", 0.3, 1.2, 0.006),
    ep("four/fp8", 0.3, 1.2, 0.006),
    ep("five/fp8", 0.3, 1.2, 0.006),
  ]);

  test("reverts a ban that leaves a model below k", () => {
    const res = preflight([alpha, beta], new Set(), new Set(["one", "three"]), [{ provider: "one", action: "ban" }], 2);
    expect(res.auto.has("one")).toBe(false);
    expect(res.auto.has("three")).toBe(true);
    expect(res.reverted).toEqual([{ provider: "one", slug: "x/alpha", admissible: 1, required: 2 }]);
    expect(violations([alpha, beta], new Set(), res.auto, 2)).toEqual([]);
  });

  test("prefers reverting fresh bans over existing ones", () => {
    const res = preflight([beta], new Set(), new Set(["four", "five"]), [{ provider: "five", action: "ban" }], 2);
    expect([...res.auto]).toEqual(["four"]);
    expect(res.reverted.map((r) => r.provider)).toEqual(["five"]);
  });

  test("never empties a model even when it has no admissible endpoints", () => {
    const solo = model(config, "z/solo", 10, [ep("only", 0.1, 0.5, 0.01, { quantization: "unknown" })]);
    const res = preflight([solo], new Set(), new Set(["only"]), [{ provider: "only", action: "ban" }], 2);
    expect(res.auto.size).toBe(0);
  });

  test("lowers the requirement when fixed bans already leave fewer than k", () => {
    expect(violations([alpha], new Set(["two"]), new Set(), 2)).toEqual([]);
    expect(violations([alpha], new Set(["two"]), new Set(["one"]), 2)).toHaveLength(1);
  });
});
