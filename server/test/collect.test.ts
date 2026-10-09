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

  test("covers exactly the last N completed UTC days", () => {
    const days = ["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
    const usage = aggregateUsage(
      days.map((d) => row(`${d} 00:00:00`, 0, 0)),
      7,
      new Date("2026-10-07T15:00:00Z"),
    );
    expect(usage.get("x/alpha")!.prompt).toBe(7000);
  });

  test("keeps requests and a per-day breakdown across providers", () => {
    const usage = aggregateUsage(
      [row("2026-10-05 00:00:00", 100, 0), { ...row("2026-10-06 00:00:00", 100, 0), provider_name: "A" }, { ...row("2026-10-06 00:00:00", 100, 0), provider_name: "B" }],
      7,
      new Date("2026-10-07T12:00:00Z"),
    );
    const u = usage.get("x/alpha")!;
    expect(u.requests).toBe(3);
    expect([...u.daily.values()].map((d) => [d.day, d.prompt])).toEqual([
      ["2026-10-05", 1000],
      ["2026-10-06", 2000],
    ]);
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
