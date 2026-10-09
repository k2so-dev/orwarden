import type { Config } from "../settings.ts";
import type { ActivityRow, Guardrail, OpenRouterApi, RawEndpoint } from "./openrouter.ts";
import type { Endpoint, ModelInput, Snapshot, UsageDay } from "./types.ts";

const PER_MILLION = 1_000_000;

const price = (v: string | null | undefined): number | null => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n * PER_MILLION : null;
};

export const providerOf = (tag: string): string => tag.split("/")[0]!.toLowerCase();

export function normalizeEndpoint(raw: RawEndpoint, zdr = false): Endpoint {
  const pIn = price(raw.pricing.prompt) ?? 0;
  const cache = price(raw.pricing.input_cache_read);
  const uptime = raw.uptime_last_1d ?? raw.uptime_last_30m ?? 100;
  return {
    tag: raw.tag,
    provider: providerOf(raw.tag),
    providerName: raw.provider_name ?? providerOf(raw.tag),
    quantization: (raw.quantization ?? "unknown").toLowerCase(),
    pIn,
    pOut: price(raw.pricing.completion) ?? 0,
    pCache: cache ?? pIn,
    cacheKnown: cache !== null,
    uptime: Math.min(Math.max(uptime / 100, 0), 1),
    uptime30m: raw.uptime_last_30m == null ? null : Math.min(Math.max(raw.uptime_last_30m / 100, 0), 1),
    tps: raw.throughput_last_30m?.p50 ?? null,
    latencyMs: raw.latency_last_30m?.p50 ?? null,
    tools: raw.supported_parameters ? raw.supported_parameters.includes("tools") : true,
    zdr,
  };
}

const ZDR_AUTHORS: Record<string, keyof Guardrail> = {
  anthropic: "enforce_zdr_anthropic",
  openai: "enforce_zdr_openai",
  google: "enforce_zdr_google",
  "x-ai": "enforce_zdr_xai",
  xai: "enforce_zdr_xai",
};

export function zdrEnforced(guardrail: Guardrail, slug: string): boolean {
  if (guardrail.enforce_zdr) return true;
  const author = slug.split("/")[0]!.toLowerCase();
  return Boolean(guardrail[ZDR_AUTHORS[author] ?? "enforce_zdr_other"]);
}

export function stripVariant(slug: string): string {
  return slug.replace(/:[a-z0-9-]+$/i, "");
}

export function aggregateUsage(rows: ActivityRow[], windowDays: number, now: Date) {
  const today = Math.floor(now.getTime() / 86_400_000) * 86_400_000;
  const since = today - windowDays * 86_400_000;
  const byModel = new Map<string, { usd: number; prompt: number; completion: number; cached: number; requests: number; daily: Map<string, UsageDay> }>();
  for (const row of rows) {
    const day = Date.parse(`${row.date.replace(" ", "T")}Z`);
    if (!Number.isFinite(day) || day < since || day >= today) continue;
    const acc = byModel.get(row.model) ?? { usd: 0, prompt: 0, completion: 0, cached: 0, requests: 0, daily: new Map<string, UsageDay>() };
    const key = new Date(day).toISOString().slice(0, 10);
    const d = acc.daily.get(key) ?? { day: key, usd: 0, prompt: 0, completion: 0, cached: 0, requests: 0 };
    const completion = Math.max(row.completion_tokens ?? 0, row.reasoning_tokens ?? 0);
    for (const target of [acc, d]) {
      target.usd += row.usage ?? 0;
      target.prompt += row.prompt_tokens ?? 0;
      target.completion += completion;
      target.cached += row.cached_tokens ?? 0;
      target.requests += row.requests ?? 0;
    }
    acc.daily.set(key, d);
    byModel.set(row.model, acc);
  }
  return byModel;
}

export async function collect(
  client: OpenRouterApi,
  config: Config,
  guardrail: Guardrail,
  now: Date,
  openWeights: ReadonlySet<string> | null = null,
): Promise<Snapshot> {
  const usage = aggregateUsage(await client.getActivity(), config.usageWindowDays, now);
  const excluded = new Set(config.excludedModels);
  const inputs = new Map<string, Omit<ModelInput, "endpoints" | "name">>();
  for (const [slug, u] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
    if (excluded.has(slug)) continue;
    const prompt = u.prompt;
    inputs.set(slug, {
      slug,
      usageUsd: u.usd,
      inputTokens: prompt,
      h: prompt > 0 ? Math.min(u.cached / prompt, 1) : config.defaultProfile.h,
      r: prompt > 0 ? u.completion / prompt : config.defaultProfile.r,
      requests: u.requests,
      daily: [...u.daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
      source: "usage",
    });
  }
  for (const w of config.watchlist) {
    const existing = inputs.get(w.slug);
    if (!existing) {
      inputs.set(w.slug, { slug: w.slug, usageUsd: w.weightUsd, inputTokens: 0, ...config.defaultProfile, source: "watchlist" });
    } else if (existing.usageUsd < w.weightUsd) {
      existing.usageUsd = w.weightUsd;
    }
  }

  const zdr = new Set((await client.getZdrEndpoints()).map((e) => `${e.model_id}|${e.tag}`));
  const models: ModelInput[] = [];
  const skipped: string[] = [];
  for (const input of inputs.values()) {
    const raw = await client.getEndpoints(input.slug);
    if (!raw || raw.length === 0) {
      skipped.push(input.slug);
      continue;
    }
    const base = stripVariant(input.slug);
    const isZdr = (e: RawEndpoint) => zdr.has(`${e.model_id ?? base}|${e.tag}`);
    const zdrOnly = zdrEnforced(guardrail, input.slug) ? raw.filter(isZdr) : raw;
    const endpoints = (zdrOnly.length > 0 ? zdrOnly : raw)
      .map((e) => normalizeEndpoint(e, isZdr(e)))
      .sort((a, b) => a.tag.localeCompare(b.tag) || a.pIn - b.pIn);
    models.push({ ...input, name: raw[0]?.model_name ?? input.slug, openWeights: openWeights ? openWeights.has(base) : true, endpoints });
  }
  return { takenAt: now.toISOString(), models, skipped };
}
