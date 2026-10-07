import { describe, expect, test } from "bun:test";
import { forecast, pricePerMillion } from "../src/core/forecast.ts";
import { ep, model, testConfig } from "./helpers.ts";

describe("forecast", () => {
  const config = testConfig();
  const m = model(config, "x/alpha", 10, [
    ep("cheap/fp8", 0.1, 0.4, 0.01, { tools: false }),
    ep("mid/fp8", 0.2, 0.8, 0.02),
    ep("dear/fp8", 0.4, 1.6, 0.04),
  ]);

  test("routes only to tool-capable endpoints when tools are required", () => {
    const withTools = pricePerMillion(m, new Set(), 0, 0, true, "prompt");
    const without = pricePerMillion(m, new Set(), 0, 0, false, "prompt");
    expect(withTools.endpoints).toBe(2);
    expect(without.endpoints).toBe(3);
    expect(withTools.price!).toBeGreaterThan(without.price!);
  });

  test("uses raw prices: single endpoint costs exactly its blended price", () => {
    const { price } = pricePerMillion(m, new Set(["mid", "dear"]), 0.5, 1, false, "prompt");
    expect(price!).toBeCloseTo(0.5 * 0.1 + 0.5 * 0.01 + 0.4, 10);
  });

  test("reports none when bans leave nothing for the request type", () => {
    const [, ...tables] = forecast([m], [{ name: "target", banned: new Set(["mid", "dear"]) }], config, 7);
    const agent = tables.find((t) => t.profile.name === "agent")!;
    expect(agent.rows[0]!.cells[0]!.perDay).toBeNull();
    const chat = tables.find((t) => t.profile.name === "chat")!;
    expect(chat.rows[0]!.cells[0]!.perDay).not.toBeNull();
  });

  test("actual scenario skips models without traffic", () => {
    const [actual] = forecast([m], [{ name: "now", banned: new Set() }], config, 7);
    expect(actual!.rows).toEqual([]);
  });
});
