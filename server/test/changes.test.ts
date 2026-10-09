import { describe, expect, test } from "bun:test";
import { changeLine, isSignificant, priceChanges } from "../src/core/changes.ts";
import type { PriceEvent } from "../src/db.ts";

const at = (day: number) => new Date(Date.UTC(2026, 9, 1 + day)).toISOString();
const event = (day: number, kind: PriceEvent["kind"], pIn: number, pOut = 2, quantization = "fp8", tag = "a/fp8"): PriceEvent => ({
  ts: at(day),
  model: "m",
  tag,
  slot: 0,
  kind,
  pIn,
  pOut,
  pCache: 0.1,
  quantization,
});
const flat = () => ({ h: 0, r: 0 });

describe("price changes", () => {
  test("pair each change with the previous price and skip baselines", () => {
    const changes = priceChanges([event(0, "baseline", 1), event(2, "changed", 1.75, 3), event(1, "added", 1, 2, "fp8", "b/fp8")], flat);
    expect(changes.map((c) => [c.kind, c.tag])).toEqual([
      ["changed", "a/fp8"],
      ["added", "b/fp8"],
    ]);
    expect(changes[0]!.prev).toEqual({ pIn: 1, pOut: 2, pCache: 0.1 });
    expect(changes[0]!.inPct).toBeCloseTo(0.75, 9);
    expect(changes[0]!.outPct).toBeCloseTo(0.5, 9);
    expect(changes[0]!.blendedPct).toBeCloseTo(0.75, 9);
    expect(changes[1]!.prev).toBeNull();
  });

  test("blended change uses the model workload", () => {
    const events = [event(0, "baseline", 1, 2), event(1, "changed", 1, 4)];
    expect(priceChanges(events, () => ({ h: 0, r: 1 }))[0]!.blendedPct).toBeCloseTo(5 / 3 - 1, 9);
    expect(priceChanges(events, flat)[0]!.blendedPct).toBe(0);
  });

  test("small moves are not significant unless the output price or quantization moved", () => {
    const [small] = priceChanges([event(0, "baseline", 1), event(1, "changed", 1.05)], flat);
    expect(isSignificant(small!)).toBe(false);
    const [output] = priceChanges([event(0, "baseline", 1), event(1, "changed", 1, 2.4)], flat);
    expect(isSignificant(output!)).toBe(true);
    const [quant] = priceChanges([event(0, "baseline", 1), event(1, "changed", 1, 2, "fp4")], flat);
    expect(isSignificant(quant!)).toBe(true);
    expect(changeLine(quant!)).toContain("fp8→fp4");
  });

  test("lines describe the move", () => {
    const [c] = priceChanges([event(0, "baseline", 1), event(1, "changed", 1.75, 3)], flat);
    expect(changeLine(c!)).toBe("m: a/fp8 +75% at your workload (in 1→1.75, out 2→3)");
    const [gone] = priceChanges([event(0, "baseline", 1), event(1, "removed", 1)], flat);
    expect(changeLine(gone!)).toBe("m: a/fp8 removed");
  });
});
