import { describe, expect, test } from "bun:test";
import { aggregateUsage } from "../src/core/collect.ts";

describe("aggregateUsage", () => {
  const row = (date: string, completion: number, reasoning: number) => ({
    date,
    model: "x/alpha",
    usage: 1,
    requests: 1,
    prompt_tokens: 1000,
    completion_tokens: completion,
    reasoning_tokens: reasoning,
    cached_tokens: 500,
  });

  test("counts reasoning tokens as output when they exceed completion", () => {
    const usage = aggregateUsage([row("2026-10-06 00:00:00", 100, 300)], 7, new Date("2026-10-07T12:00:00Z"));
    expect(usage.get("x/alpha")!.completion).toBe(300);
  });

  test("drops rows outside the window", () => {
    const usage = aggregateUsage(
      [row("2026-10-06 00:00:00", 100, 0), row("2026-09-01 00:00:00", 100, 0)],
      7,
      new Date("2026-10-07T12:00:00Z"),
    );
    expect(usage.get("x/alpha")!.prompt).toBe(1000);
  });
});
