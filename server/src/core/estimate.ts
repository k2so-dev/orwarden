import { unitCost } from "./cost.ts";
import type { Stability } from "./stability.ts";
import type { Endpoint, UsageDay } from "./types.ts";

export type RiskKind = "routing" | "price-volatility" | "fallback-cache" | "workload-drift" | "default-model" | "thin-data" | "calibration";
export type RiskLevel = "info" | "warn" | "bad";
export type Risk = { kind: RiskKind; level: RiskLevel; text: string; impactUsd: number | null };
export type Confidence = "high" | "medium" | "low";
export type Estimate = { value: number; low: number; high: number; confidence: Confidence; risks: Risk[] };

export type Drift = { hStd: number; rStd: number; days: number };

export type Calibration = { actualUsd: number; predictedUsd: number; lowUsd: number; basis: "preset" | "default"; days: number; error: number };

export type EstimateInput = {
  members: readonly { endpoint: Endpoint; stability: Stability }[];
  h: number;
  r: number;
  tokens: number;
  drift: Drift | null;
  contextTokens: number | null;
  estimated: boolean;
  defaultRange: { low: number; high: number } | null;
  calibration?: Calibration | null;
};

const MIN_DRIFT_DAYS = 3;

export function usd(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return "$0";
  return abs < 0.01 ? `$${abs.toPrecision(2)}` : `$${abs.toFixed(2)}`;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function workloadDrift(daily: readonly UsageDay[] | undefined): Drift | null {
  const days = (daily ?? []).filter((d) => d.prompt > 0);
  if (days.length < MIN_DRIFT_DAYS) return null;
  const std = (values: number[]) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  };
  return {
    hStd: std(days.map((d) => Math.min(d.cached / d.prompt, 1))),
    rStd: std(days.map((d) => d.completion / d.prompt)),
    days: days.length,
  };
}

export function calibrate(actualUsd: number, lowUsd: number, predictedUsd: number, basis: Calibration["basis"], days: number): Calibration | null {
  if (actualUsd <= 0 || predictedUsd <= 0) return null;
  const error = actualUsd > predictedUsd ? actualUsd / predictedUsd - 1 : actualUsd < lowUsd ? actualUsd / lowUsd - 1 : 0;
  return { actualUsd, predictedUsd, lowUsd, basis, days, error };
}

export function confidenceOf(risks: readonly Risk[]): Confidence {
  if (risks.some((r) => r.level === "bad")) return "low";
  if (risks.some((r) => r.level === "warn" || r.kind === "thin-data")) return "medium";
  return "high";
}

export function presetEstimate(input: EstimateInput): Estimate | null {
  const { members, h, r, tokens } = input;
  if (members.length === 0) return null;
  const money = (perM: number) => (perM * tokens) / 1_000_000;
  const costs = members.map((m) => unitCost(m.endpoint, h, r));
  const value = money(Math.max(...costs));
  const low = money(Math.min(...costs));
  const risks: Risk[] = [];

  if (members.length > 1 && value - low > value * 0.01) {
    risks.push({
      kind: "routing",
      level: "info",
      text: `OpenRouter picks one of ${members.length} listed providers for each conversation, so the cost lands between ${usd(low)} and ${usd(value)}.`,
      impactUsd: null,
    });
  }

  const swing = Math.max(...members.map((m) => m.stability.priceSwing));
  const changes = members.reduce((a, m) => a + m.stability.priceChanges, 0);
  if (swing > 1.0001) {
    const impact = value * (swing - 1);
    risks.push({
      kind: "price-volatility",
      level: swing >= 1.25 ? "bad" : swing >= 1.1 ? "warn" : "info",
      text: `Listed providers changed price ${changes} time${changes === 1 ? "" : "s"} in 30 days, by up to ${pct(swing - 1)}. The same move again would add ${usd(impact)}.`,
      impactUsd: impact,
    });
  }

  if (h > 0) {
    const failure = Math.max(...members.map((m) => 1 - m.endpoint.uptime));
    const gap = Math.max(...members.map((m) => Math.max(m.endpoint.pIn - m.endpoint.pCache, 0)));
    const impact = money(failure * h * gap);
    if (impact > value * 0.005) {
      const context = input.contextTokens ? ` (about ${Math.round(input.contextTokens).toLocaleString("en-US")} tokens per request)` : "";
      risks.push({
        kind: "fallback-cache",
        level: impact >= value * 0.05 ? "warn" : "info",
        text: `Up to ${pct(failure)} of requests can fail over to another provider and re-read the cached context at the full input price${context}: ${usd(impact)}.`,
        impactUsd: impact,
      });
    }
  }

  const drift = input.drift;
  if (drift && (drift.hStd > 0.02 || drift.rStd > Math.max(0.05 * r, 0.005))) {
    const worse = money(Math.max(...members.map((m) => unitCost(m.endpoint, Math.max(0, h - drift.hStd), r + drift.rStd))));
    const impact = Math.max(0, worse - value);
    if (impact > value * 0.005) {
      risks.push({
        kind: "workload-drift",
        level: impact >= value * 0.1 ? "warn" : "info",
        text: `Over ${drift.days} days the cache hit varied by ±${pct(drift.hStd)} and output/input by ±${drift.rStd.toFixed(2)}. A worse stretch costs ${usd(impact)} more.`,
        impactUsd: impact,
      });
    }
  }

  if (input.defaultRange && input.defaultRange.high - input.defaultRange.low > input.defaultRange.high * 0.01) {
    risks.push({
      kind: "default-model",
      level: "info",
      text: `Default routing is modeled as OpenRouter's price-weighted spread. If it routes differently, the default would cost between ${usd(input.defaultRange.low)} and ${usd(input.defaultRange.high)}.`,
      impactUsd: null,
    });
  }

  const cal = input.calibration;
  if (cal && Math.abs(cal.error) > 0.05) {
    const model = cal.basis === "preset" ? "the preset estimate" : "the default routing model";
    risks.push({
      kind: "calibration",
      level: Math.abs(cal.error) > 0.2 ? "warn" : "info",
      text: `Last ${cal.days} days you spent ${usd(cal.actualUsd)}, ${cal.error > 0 ? "above" : "below"} ${model} for the same traffic (${usd(cal.lowUsd)}–${usd(cal.predictedUsd)}) by ${pct(Math.abs(cal.error))}.`,
      impactUsd: cal.error > 0 ? value * cal.error : null,
    });
  }

  const young = members.filter((m) => m.stability.ageDays === null || m.stability.isNew).length;
  if (input.estimated) {
    risks.push({ kind: "thin-data", level: "warn", text: "No recent traffic: volume and cache hit use defaults, not your usage.", impactUsd: null });
  } else if (young > 0) {
    risks.push({
      kind: "thin-data",
      level: "info",
      text: `${young} of ${members.length} listed provider${members.length === 1 ? " has" : "s have"} less than 7 days of history, so stability is not proven yet.`,
      impactUsd: null,
    });
  }

  const high = value + risks.reduce((a, x) => a + (x.impactUsd ?? 0), 0);
  return { value, low, high, confidence: confidenceOf(risks), risks };
}
