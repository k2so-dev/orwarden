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
  const minRank = modelMinQuantRank(model.slug, config);
  const quantOk = model.endpoints.filter((e) => quantRank(e.quantization) >= minRank);
  const pool = quantOk.length > 0 ? quantOk : model.endpoints;
  const medOut = median(pool.map((e) => e.pOut));
  const ratio = (e: { pIn: number; pCache: number }) => (e.pIn > 0 ? e.pCache / e.pIn : 0);
  const medRatio = median(pool.filter((e) => e.pIn > 0).map(ratio));
  const rScore = Math.max(model.r, config.optimizer.minOutRatio);

  const endpoints = model.endpoints.map((e) => {
    const hard: string[] = [];
    const soft: string[] = [];
    let output = false;
    let cache = false;
    if (quantRank(e.quantization) === 0) hard.push("unknown quant");
    else if (quantRank(e.quantization) < minRank) hard.push(`${e.quantization} quant`);
    const rank = quantRank(e.quantization);
    if (e.uptime < minUptime) hard.push(`uptime ${pct(e.uptime)}`);
    if (medOut > 0 && e.pOut > outliers.outVsMedian * medOut) {
      output = true;
      soft.push(`output ${times(e.pOut / medOut)} median`);
    }
    if (model.h > outliers.minHForCacheRule && medRatio > 0 && ratio(e) > outliers.cacheRatioVsMedian * medRatio) {
      cache = true;
      soft.push(`cache ${times(ratio(e) / medRatio)} median${e.cacheKnown ? "" : " (no cache price)"}`);
    }
    const cls: EndpointClass = hard.length ? "hard-bad" : soft.length ? "outlier" : "ok";
    const cEff = effectiveCost(e, model.h, rScore, config);
    return {
      ...e,
      cls,
      quant: rank === 0 ? ("unknown" as const) : rank < minRank ? ("low" as const) : ("ok" as const),
      reasons: [...hard, ...soft],
      cEff,
      score: cEff * penalty({ hard: hard.length > 0, output, cache }, config),
      weight: routingWeight(e, model.h, rScore, config.optimizer.routingPrice),
    };
  });
  return { ...model, endpoints };
}

export const classifyAll = (models: ModelInput[], config: Config) => models.map((m) => classifyModel(m, config));
