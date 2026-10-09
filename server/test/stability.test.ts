import { describe, expect, test } from "bun:test";
import { computeStability, endpointStability, NEUTRAL_STABILITY, slotKey, tagKey, type Sample } from "../src/core/stability.ts";
import type { EndpointState, PriceEvent } from "../src/db.ts";

const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, 1 + day, hour)).toISOString();
const NOW = at(40);
const prices = (pIn: number, pOut = 2, pCache = 0.1) => ({ pIn, pOut, pCache });
const event = (day: number, kind: PriceEvent["kind"], pIn: number): PriceEvent => ({ ts: at(day), model: "m", tag: "a", slot: 0, kind, quantization: "fp8", ...prices(pIn) });
const state = (firstDay: number): EndpointState => ({ model: "m", tag: "a", slot: 0, quantization: "fp8", firstSeen: at(firstDay), lastSeen: NOW, ...prices(1) });
const base = { now: NOW, h: 0, r: 0, minUptime: 0.97, samples: [] as Sample[] };

describe("stability", () => {
  test("a steady endpoint scores high", () => {
    const s = computeStability({ ...base, current: prices(1), state: state(0), events: [event(0, "baseline", 1)] });
    expect(s.score).toBe(100);
    expect(s.priceSwing).toBe(1);
    expect(s.priceTrend30d).toBe(0);
    expect(s.isNew).toBe(false);
  });

  test("a price hike shows up as trend, swing and last change", () => {
    const events = [event(0, "baseline", 1), event(38, "changed", 1.75)];
    const s = computeStability({ ...base, current: prices(1.75), state: state(0), events });
    expect(s.priceTrend7d).toBeCloseTo(0.75, 9);
    expect(s.priceTrend30d).toBeCloseTo(0.75, 9);
    expect(s.priceChanges).toBe(1);
    expect(s.lastChangeAt).toBe(at(38));
    expect(s.lastChangePct).toBeCloseTo(0.75, 9);
    expect(s.priceSwing).toBeCloseTo(1.75, 9);
    expect(s.score).toBeLessThan(60);
  });

  test("blended price follows the workload", () => {
    const events = [event(0, "baseline", 1), { ...event(38, "changed", 1), pOut: 4 }];
    const input = { ...base, current: { pIn: 1, pOut: 4, pCache: 0.1 }, state: state(0), events };
    expect(computeStability({ ...input, r: 0 }).priceTrend7d).toBe(0);
    expect(computeStability({ ...input, r: 1 }).priceTrend7d).toBeCloseTo(5 / 3 - 1, 9);
  });

  test("uptime dips count distinct days and verdict flaps count transitions", () => {
    const samples: Sample[] = [
      { ts: at(35, 1), uptime: 0.95, verdict: "ok" },
      { ts: at(35, 2), uptime: 0.9, verdict: "hard-bad" },
      { ts: at(36, 1), uptime: 0.99, verdict: "ok" },
      { ts: at(37, 1), uptime: 0.96, verdict: "ok" },
    ];
    const s = computeStability({ ...base, samples, current: prices(1), state: state(0), events: [event(0, "baseline", 1)] });
    expect(s.uptimeDips).toBe(2);
    expect(s.verdictFlaps).toBe(2);
    expect(s.uptimeMin7d).toBe(0.9);
    expect(s.score).toBe(100 - (15 * 2 + 5 * 2) / 2);
  });

  test("young endpoints are pulled towards neutral", () => {
    const events = [event(39, "added", 1)];
    const s = computeStability({ ...base, current: prices(1), state: state(39), events });
    expect(s.isNew).toBe(true);
    expect(s.ageDays).toBeCloseTo(1, 9);
    expect(s.score).toBeCloseTo(50 + 50 / 7, 1);
  });

  test("without history every endpoint is neutral", () => {
    expect(endpointStability(undefined, "m", [{ tag: "a", ...prices(1) }], NOW, { h: 0, r: 0 }, 0.97)).toEqual([NEUTRAL_STABILITY]);
  });

  test("duplicate tags read their own slot", () => {
    const history = {
      states: new Map([[slotKey("m", "a", 1), { ...state(0), slot: 1 }]]),
      events: new Map([[slotKey("m", "a", 1), [{ ...event(0, "baseline", 2), slot: 1 }, { ...event(39, "changed", 3), slot: 1 }]]]),
      samples: new Map([[tagKey("m", "a"), []]]),
    };
    const [first, second] = endpointStability(history, "m", [{ tag: "a", ...prices(1) }, { tag: "a", ...prices(3) }], NOW, { h: 0, r: 0 }, 0.97);
    expect(first!.ageDays).toBeNull();
    expect(second!.priceChanges).toBe(1);
  });
});
