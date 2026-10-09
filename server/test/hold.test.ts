import { describe, expect, test } from "bun:test";
import { decideHolds, holdCandidates, matchesModel, usageRows, type HoldInput, type UsageRow } from "../src/core/hold.ts";
import type { Hold } from "../src/db.ts";
import { ep } from "./helpers.ts";

const NOW = new Date("2026-10-07T12:00:00Z");
const pool = [ep("a/fp8", 1, 2, 0.1), ep("b/fp8", 2, 4, 0.2, { providerName: "Bee Cloud" })];
const row = (ts: string, provider: string, requests = 1, usd = 0.5, model = "m"): UsageRow => ({ ts, model, provider, requests, usd });
const input = (extra: Partial<HoldInput> = {}): HoldInput => ({
  model: "m",
  previous: ["a/fp8", "b/fp8"],
  base: ["a/fp8"],
  pool,
  holds: [],
  usage: { recent: [], hourly: [] },
  now: NOW,
  maxHours: 24,
  maxUsd: 1,
  overpayRate: () => 0.5,
  ...extra,
});
const hold = (since: string, extra: Partial<Hold> = {}): Hold => ({ model: "m", tag: "b/fp8", since, checkedAt: since, overpayUsd: 0, ...extra });

describe("preset holds", () => {
  test("a dropped provider with recent requests is held", () => {
    const d = decideHolds(input({ usage: { recent: [row("2026-10-07T11:50:00Z", "Bee Cloud")], hourly: [] } }));
    expect(d.holds).toEqual([{ model: "m", tag: "b/fp8", since: NOW.toISOString(), checkedAt: NOW.toISOString(), overpayUsd: 0 }]);
    expect(d.released).toEqual([]);
  });

  test("a dropped provider without recent requests goes", () => {
    const d = decideHolds(input({ usage: { recent: [row("2026-10-07T11:40:00Z", "Bee Cloud")], hourly: [] } }));
    expect(d.holds).toEqual([]);
    expect(d.released).toEqual([{ tag: "b/fp8", reason: "cold" }]);
  });

  test("an ineligible provider goes even when warm", () => {
    const d = decideHolds(input({ pool: [pool[0]!], usage: { recent: [row("2026-10-07T11:55:00Z", "Bee Cloud")], hourly: [] } }));
    expect(d.released).toEqual([{ tag: "b/fp8", reason: "ineligible" }]);
  });

  test("holds end after the time limit or the overpay budget", () => {
    const warm = [row("2026-10-07T11:58:00Z", "Bee Cloud")];
    const expired = decideHolds(input({ holds: [hold("2026-10-06T11:00:00Z")], usage: { recent: warm, hourly: [] } }));
    expect(expired.released).toEqual([{ tag: "b/fp8", reason: "expired" }]);
    const hourly = [row("2026-10-07T09:00:00Z", "Bee Cloud", 10, 1.5), row("2026-10-07T11:00:00Z", "Bee Cloud", 10, 1), row("2026-10-07T07:00:00Z", "Bee Cloud", 10, 9)];
    const budget = decideHolds(input({ holds: [hold("2026-10-07T09:30:00Z")], usage: { recent: warm, hourly } }));
    expect(budget.released).toEqual([{ tag: "b/fp8", reason: "budget" }]);
    const kept = decideHolds(input({ holds: [hold("2026-10-07T09:30:00Z")], usage: { recent: warm, hourly }, maxUsd: 2 }));
    expect(kept.holds[0]!.overpayUsd).toBeCloseTo(1.25, 9);
    expect(kept.holds[0]!.since).toBe("2026-10-07T09:30:00Z");
  });

  test("without usage data a hold is kept until its time limit", () => {
    expect(decideHolds(input({ usage: null })).holds.map((h) => h.tag)).toEqual(["b/fp8"]);
    expect(decideHolds(input({ usage: null, holds: [hold("2026-10-06T10:00:00Z")] })).released[0]!.reason).toBe("expired");
  });

  test("a provider back in the ranking ends its hold", () => {
    expect(holdCandidates(["a/fp8"], ["a/fp8", "b/fp8"], [hold("2026-10-07T11:00:00Z")])).toEqual([]);
    expect(holdCandidates(["a/fp8", "c"], ["a/fp8"], [hold("2026-10-07T11:00:00Z")])).toEqual(["c", "b/fp8"]);
  });

  test("analytics rows map to models and providers", () => {
    expect(matchesModel("deepseek/deepseek-v3.2-20251201", "deepseek/deepseek-v3.2")).toBe(true);
    expect(matchesModel("deepseek/deepseek-v3.2-exp", "deepseek/deepseek-v3.2")).toBe(false);
    const [r] = usageRows([{ created_at__minute: "2026-10-07 11:55:00", model: "m-20260901", provider: "Bee Cloud", request_count: "3", total_usage: 0.25 }], "minute");
    expect(r).toEqual({ ts: "2026-10-07T11:55:00Z", model: "m-20260901", provider: "Bee Cloud", requests: 3, usd: 0.25 });
    expect(decideHolds(input({ usage: { recent: [r!], hourly: [] } })).holds).toHaveLength(1);
  });
});
