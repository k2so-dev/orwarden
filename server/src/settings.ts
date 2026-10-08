import { z } from "zod";

const ratio = z.number().min(0).max(1);
const positive = z.number().positive();

export const PRESET_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export const ScenarioSchema = z.object({
  name: z.string().min(1).max(40),
  tools: z.boolean(),
  h: ratio,
  r: z.number().min(0).max(50),
});

export const SettingsSchema = z.object({
  mode: z.enum(["dry-run", "apply"]),
  workspaceId: z.string().nullable(),
  refreshCron: z.string().min(9).max(100),
  usageWindowDays: z.number().int().min(1).max(30),
  defaultProfile: z.object({ h: ratio, r: z.number().min(0).max(50) }),
  watchlist: z.array(z.object({ slug: z.string().min(3), weightUsd: z.number().min(0) })),
  excludedModels: z.array(z.string()),
  filters: z.object({
    minQuantization: z.string(),
    nativeQuantization: z.record(z.string(), z.string()),
    banLowQuantProviders: z.boolean(),
    zdrOnly: z.boolean(),
    minUptime: ratio,
    minTps: z.number().min(0),
    slowPenalty: z.number().min(1),
    outliers: z.object({ outVsMedian: positive, hardOutVsMedian: positive, cacheRatioVsMedian: positive, minHForCacheRule: ratio }),
  }),
  optimizer: z.object({
    minEndpointsPerModel: z.number().int().min(1).max(10),
    routingPrice: z.enum(["prompt", "prompt_plus_completion", "blended"]),
    minImprovement: z.number().min(0).max(1),
    maxMoves: z.number().int().min(0).max(200),
    maxChangesPerRun: z.number().int().min(1).max(50),
    minOutRatio: z.number().min(0).max(50),
    penalties: z.object({ hardBad: z.number().min(1), outputOutlier: z.number().min(1), cacheOutlier: z.number().min(1) }),
    hysteresis: z.object({ banAfterRuns: z.number().int().min(1), unbanAfterRuns: z.number().int().min(1) }),
  }),
  scoring: z.object({ price: z.number().min(0), speed: z.number().min(0), reliability: z.number().min(0), unknownQuantPenalty: z.number().min(0).max(100) }),
  presets: z.object({
    topN: z.number().int().min(1).max(20),
    slugPattern: z.string().includes("{model}"),
    defaultScenario: z.string(),
    rankBy: z.enum(["score", "cost"]),
  }),
  scenarios: z.object({
    days: z.number().int().min(1).max(365),
    inputTokensPerDay: z.number().min(0),
    profiles: z.array(ScenarioSchema).min(1),
  }),
  alerts: z.object({
    webhook: z.string().url().nullable(),
    telegramBotToken: z.string().nullable(),
    telegramChatId: z.string().nullable(),
  }),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type Config = Settings;
export type RoutingPrice = Settings["optimizer"]["routingPrice"];
export type Mode = Settings["mode"];
export type Scenario = z.infer<typeof ScenarioSchema>;

export const DEFAULT_SETTINGS: Settings = {
  mode: "dry-run",
  workspaceId: null,
  refreshCron: "0 * * * *",
  usageWindowDays: 7,
  defaultProfile: { h: 0.5, r: 0.2 },
  watchlist: [],
  excludedModels: [],
  filters: {
    minQuantization: "fp8",
    nativeQuantization: { "openai/gpt-oss": "fp4" },
    banLowQuantProviders: true,
    zdrOnly: false,
    minUptime: 0.97,
    minTps: 0,
    slowPenalty: 1.2,
    outliers: { outVsMedian: 1.5, hardOutVsMedian: 2.5, cacheRatioVsMedian: 3, minHForCacheRule: 0.3 },
  },
  optimizer: {
    minEndpointsPerModel: 2,
    routingPrice: "prompt",
    minImprovement: 0.01,
    maxMoves: 20,
    maxChangesPerRun: 3,
    minOutRatio: 0.5,
    penalties: { hardBad: 3, outputOutlier: 5, cacheOutlier: 1.5 },
    hysteresis: { banAfterRuns: 2, unbanAfterRuns: 3 },
  },
  scoring: { price: 60, speed: 20, reliability: 20, unknownQuantPenalty: 15 },
  presets: { topN: 5, slugPattern: "{model}-safe", defaultScenario: "actual", rankBy: "score" },
  scenarios: {
    days: 7,
    inputTokensPerDay: 1_000_000,
    profiles: [
      { name: "chat", tools: false, h: 0, r: 0.3 },
      { name: "chat-cached", tools: false, h: 0.5, r: 0.3 },
      { name: "agent", tools: true, h: 0.8, r: 0.05 },
      { name: "reasoning", tools: false, h: 0, r: 1 },
    ],
  },
  alerts: { webhook: null, telegramBotToken: null, telegramChatId: null },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return (patch === undefined ? base : patch) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const current = (base as Plain)[k];
    out[k] = isPlain(current) && isPlain(v) && k !== "nativeQuantization" ? deepMerge(current, v) : v;
  }
  return out as T;
}

export function mergeSettings(base: Settings, patch: unknown): Settings {
  return SettingsSchema.parse(deepMerge(base, patch));
}
