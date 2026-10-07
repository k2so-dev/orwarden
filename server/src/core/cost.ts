import type { Config, RoutingPrice } from "../settings.ts";
import type { ClassifiedModel, Endpoint } from "./types.ts";

export function unitCost(e: Endpoint, h: number, r: number): number {
  return (1 - h) * e.pIn + h * e.pCache + r * e.pOut;
}

export function effectiveCost(e: Endpoint, h: number, r: number, config: Config): number {
  const { minTps, slowPenalty } = config.filters;
  const slow = minTps > 0 && e.tps !== null && e.tps < minTps ? slowPenalty : 1;
  return (unitCost(e, h, r) / Math.max(e.uptime, 0.01)) * slow;
}

export function routingWeight(e: Endpoint, h: number, r: number, mode: RoutingPrice): number {
  const p = mode === "prompt" ? e.pIn : mode === "prompt_plus_completion" ? e.pIn + e.pOut : unitCost(e, h, r);
  return e.uptime / Math.max(p, 1e-9) ** 2;
}

export function penalty(flags: { hard: boolean; output: boolean; cache: boolean }, config: Config): number {
  const { hardBad, outputOutlier, cacheOutlier } = config.optimizer.penalties;
  return (flags.hard ? hardBad : 1) * (flags.output ? outputOutlier : 1) * (flags.cache ? cacheOutlier : 1);
}

export function expCost(model: ClassifiedModel, banned: ReadonlySet<string>): number | null {
  let weights = 0;
  let total = 0;
  for (const e of model.endpoints) {
    if (banned.has(e.provider)) continue;
    weights += e.weight;
    total += e.weight * e.score;
  }
  return weights > 0 ? total / weights : null;
}

export type Baseline = Map<string, number | null>;

export function baselineOf(models: ClassifiedModel[], banned: ReadonlySet<string>): Baseline {
  return new Map(models.map((m) => [m.slug, expCost(m, banned)]));
}

export function modelSpend(model: ClassifiedModel, banned: ReadonlySet<string>, baseline: Baseline): number {
  const base = baseline.get(model.slug);
  if (!base || model.usageUsd <= 0) return 0;
  const cost = expCost(model, banned);
  return cost === null ? Infinity : (model.usageUsd * cost) / base;
}

export function objective(models: ClassifiedModel[], banned: ReadonlySet<string>, baseline: Baseline): number {
  let sum = 0;
  for (const m of models) sum += modelSpend(m, banned, baseline);
  return sum;
}
