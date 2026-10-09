import { describe, expect, test } from "bun:test";
import { calibrate, confidenceOf, presetEstimate, workloadDrift, type EstimateInput } from "../src/core/estimate.ts";
import { NEUTRAL_STABILITY, type Stability } from "../src/core/stability.ts";
import { ep } from "./helpers.ts";

const steady: Stability = { ...NEUTRAL_STABILITY, score: 100, ageDays: 30 };
const member = (tag: string, pIn: number, extra: Partial<ReturnType<typeof ep>> = {}, stability = steady) => ({ endpoint: ep(tag, pIn, 2, pIn / 10, { uptime: 1, ...extra }), stability });
const base: EstimateInput = { members: [], h: 0, r: 0, tokens: 1_000_000, drift: null, contextTokens: null, estimated: false, defaultRange: null };
const kinds = (input: EstimateInput) => presetEstimate(input)!.risks.map((r) => r.kind);

describe("preset estimate", () => {
  test("is the worst listed provider with the cheapest as the low end", () => {
    const e = presetEstimate({ ...base, members: [member("a", 1), member("b", 1.2)] })!;
    expect(e.value).toBeCloseTo(1.2, 9);
    expect(e.low).toBeCloseTo(1, 9);
    expect(e.high).toBeCloseTo(1.2, 9);
    expect(e.risks.map((r) => r.kind)).toEqual(["routing"]);
    expect(e.confidence).toBe("high");
  });

  test("returns null for an empty preset", () => {
    expect(presetEstimate(base)).toBeNull();
  });

  test("price swings widen the high end and lower confidence", () => {
    const e = presetEstimate({ ...base, members: [member("a", 1, {}, { ...steady, priceSwing: 1.3, priceChanges: 2 })] })!;
    expect(e.risks[0]!.kind).toBe("price-volatility");
    expect(e.risks[0]!.level).toBe("bad");
    expect(e.high).toBeCloseTo(1.3, 9);
    expect(e.confidence).toBe("low");
  });

  test("failover re-reads cached context at the full price", () => {
    const e = presetEstimate({ ...base, h: 0.9, members: [member("a", 1, { uptime: 0.95 })], contextTokens: 950_000 })!;
    const risk = e.risks.find((r) => r.kind === "fallback-cache")!;
    expect(risk.impactUsd).toBeCloseTo(0.05 * 0.9 * 0.9, 9);
    expect(risk.text).toContain("950,000 tokens");
    expect(kinds({ ...base, h: 0, members: [member("a", 1, { uptime: 0.95 })] })).not.toContain("fallback-cache");
  });

  test("workload drift prices a worse stretch", () => {
    const e = presetEstimate({ ...base, h: 0.8, r: 0.1, members: [member("a", 1)], drift: { hStd: 0.1, rStd: 0.05, days: 7 } })!;
    const risk = e.risks.find((r) => r.kind === "workload-drift")!;
    const at = (h: number, r: number) => (1 - h) * 1 + h * 0.1 + r * 2;
    expect(risk.impactUsd).toBeCloseTo(at(0.7, 0.15) - at(0.8, 0.1), 9);
  });

  test("young providers and missing traffic are thin data", () => {
    expect(kinds({ ...base, members: [member("a", 1, {}, NEUTRAL_STABILITY)] })).toEqual(["thin-data"]);
    const e = presetEstimate({ ...base, estimated: true, members: [member("a", 1)] })!;
    expect(e.risks[0]!.level).toBe("warn");
    expect(e.confidence).toBe("medium");
  });

  test("confidence follows the worst risk", () => {
    expect(confidenceOf([])).toBe("high");
    expect(confidenceOf([{ kind: "thin-data", level: "info", text: "", impactUsd: null }])).toBe("medium");
    expect(confidenceOf([{ kind: "routing", level: "info", text: "", impactUsd: null }])).toBe("high");
  });
});

describe("calibration", () => {
  test("measures the error outside the predicted range only", () => {
    expect(calibrate(10, 8, 12, "preset", 7)!.error).toBe(0);
    expect(calibrate(15, 8, 12, "preset", 7)!.error).toBeCloseTo(0.25, 9);
    expect(calibrate(6, 8, 12, "preset", 7)!.error).toBeCloseTo(-0.25, 9);
    expect(calibrate(0, 8, 12, "default", 7)).toBeNull();
  });

  test("an underestimate widens the high end", () => {
    const calibration = calibrate(15, 12, 12, "default", 7);
    const e = presetEstimate({ ...base, members: [member("a", 1)], calibration })!;
    const risk = e.risks.find((r) => r.kind === "calibration")!;
    expect(risk.level).toBe("warn");
    expect(risk.text).toContain("above the default routing model");
    expect(e.high).toBeCloseTo(1.25, 9);
  });

  test("small errors are not reported", () => {
    expect(kinds({ ...base, members: [member("a", 1)], calibration: calibrate(12.4, 12, 12, "default", 7) })).toEqual([]);
  });
});

describe("workload drift", () => {
  test("needs three days with traffic", () => {
    const day = (cached: number, completion: number) => ({ day: "d", usd: 0, prompt: 100, completion, cached, requests: 1 });
    expect(workloadDrift([day(80, 10), day(60, 10)])).toBeNull();
    const d = workloadDrift([day(80, 10), day(60, 10), day(70, 10)])!;
    expect(d.hStd).toBeCloseTo(Math.sqrt(200 / 3) / 100, 9);
    expect(d.rStd).toBeCloseTo(0, 12);
  });
});
