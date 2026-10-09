import type { Config, RoutingPrice } from "../settings.ts";
import type { Endpoint } from "./types.ts";

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
