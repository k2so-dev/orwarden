import type { Config } from "../settings.ts";
import { effectiveCost, penalty, routingWeight } from "./cost.ts";
import type { ClassifiedModel, EndpointClass, ModelInput } from "./types.ts";

const QUANT_RANK: Record<string, number> = {
  int4: 1,
  fp4: 1,
  mxfp4: 1,
  nvfp4: 1,
  fp6: 2,
  int8: 3,
  fp8: 3,
  mxfp8: 3,
  fp16: 4,
  bf16: 4,
  fp32: 5,
};

export const quantRank = (q: string): number => QUANT_RANK[q.toLowerCase()] ?? 0;

export function modelMinQuantRank(slug: string, config: Config): number {
  let rank = quantRank(config.filters.minQuantization);
  for (const [prefix, native] of Object.entries(config.filters.nativeQuantization)) {
    if (slug.startsWith(prefix)) rank = Math.min(rank, quantRank(native));
  }
  return rank;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const pct = (v: number) => `${+(v * 100).toFixed(1)}%`;
const times = (v: number) => `${v >= 10 ? Math.round(v) : +v.toFixed(1)}x`;

export function classifyModel(model: ModelInput, config: Config): ClassifiedModel {
  const { minUptime, outliers } = config.filters;
  const open = model.openWeights !== false;
  const minRank = open ? modelMinQuantRank(model.slug, config) : 0;
  const quantOk = model.endpoints.filter((e) => quantRank(e.quantization) >= minRank);
  const pool = quantOk.length > 0 ? quantOk : model.endpoints;
  const medOut = median(pool.map((e) => e.pOut));
  const medCache = median(pool.filter((e) => e.cacheKnown).map((e) => e.pCache));
  const rScore = Math.max(model.r, config.optimizer.minOutRatio);

  const endpoints = model.endpoints.map((e) => {
    const hard: string[] = [];
    const soft: string[] = [];
    let output = false;
    let cache = false;
    if (open && quantRank(e.quantization) === 0) hard.push("unknown quant");
    else if (open && quantRank(e.quantization) < minRank) hard.push(`${e.quantization} quant`);
    const rank = quantRank(e.quantization);
    if (e.uptime < minUptime) hard.push(`uptime ${pct(e.uptime)}`);
    if (medOut > 0 && e.pOut > outliers.hardOutVsMedian * medOut) {
      output = true;
      hard.push(`output ${times(e.pOut / medOut)} median`);
    } else if (medOut > 0 && e.pOut > outliers.outVsMedian * medOut) {
      output = true;
      soft.push(`output ${times(e.pOut / medOut)} median`);
    }
    if (model.h > outliers.minHForCacheRule && medCache > 0 && e.pCache > outliers.cacheRatioVsMedian * medCache) {
      cache = true;
      soft.push(`cache ${times(e.pCache / medCache)} median${e.cacheKnown ? "" : " (no cache price)"}`);
    }
    const cls: EndpointClass = hard.length ? "hard-bad" : soft.length ? "outlier" : "ok";
    const cEff = effectiveCost(e, model.h, rScore, config);
    return {
      ...e,
      cls,
      quant: !open ? ("closed" as const) : rank === 0 ? ("unknown" as const) : rank < minRank ? ("low" as const) : ("ok" as const),
      reasons: [...hard, ...soft],
      issues: [...hard.map((text) => ({ level: "bad" as const, text })), ...soft.map((text) => ({ level: "warn" as const, text }))],
      cEff,
      score: cEff * penalty({ hard: hard.length > 0, output, cache }, config),
      weight: routingWeight(e, model.h, rScore, config.optimizer.routingPrice),
    };
  });
  return { ...model, endpoints };
}

export const classifyAll = (models: ModelInput[], config: Config) => models.map((m) => classifyModel(m, config));
