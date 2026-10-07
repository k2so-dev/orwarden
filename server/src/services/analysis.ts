import { createHash } from "node:crypto";
import { classifyModel, modelMinQuantRank, quantRank } from "../core/classify.ts";
import { unitCost } from "../core/cost.ts";
import { pricePerMillion } from "../core/forecast.ts";
import type { ProviderState } from "../core/hysteresis.ts";
import type { Guardrail } from "../core/openrouter.ts";
import { admissibleCount, optimize, totalCount, violations, type Violation } from "../core/optimizer.ts";
import type { ClassifiedEndpoint, ClassifiedModel, ModelInput } from "../core/types.ts";
import type { Policy, PresetSettings, RunRecord } from "../db.ts";
import type { Settings } from "../settings.ts";

export type AppSnapshot = {
  takenAt: string;
  workspace: { id: string; name: string; guardrailId: string };
  key: { label: string | null; expiresAt: string | null };
  guardrail: Guardrail;
  models: ModelInput[];
  skipped: string[];
  catalog: { id: string; name: string }[];
};

export type ViewQuery = {
  scenario: string;
  h?: number;
  r?: number;
  tools?: boolean;
  tokensPerDay?: number;
  days?: number;
  minQuantization?: string;
  minUptime?: number;
  zdrOnly?: boolean;
  hideBanned?: boolean;
  wPrice?: number;
  wSpeed?: number;
  wReliability?: number;
};

export type BanInputs = {
  policies: ReadonlyMap<string, Policy>;
  states: ReadonlyMap<string, ProviderState>;
};

export type Profile = { name: string; h: number; r: number; tools: boolean; inputPerDay: number; estimated: boolean };

export type Scores = { price: number; speed: number; reliability: number; overall: number };

export type BanStatus = {
  policy: Policy | null;
  auto: boolean;
  inGuardrail: boolean;
  inDesired: boolean;
  pending: { action: "ban" | "unban"; streak: number; needed: number } | null;
};

export type EndpointView = {
  tag: string;
  provider: string;
  providerName: string;
  quantization: string;
  quant: "ok" | "low" | "unknown";
  zdr: boolean;
  tools: boolean;
  pIn: number;
  pOut: number;
  pCache: number;
  cacheKnown: boolean;
  cacheDiscount: number | null;
  outVsMedian: number | null;
  uptime: number;
  uptime30m: number | null;
  tps: number | null;
  latencyMs: number | null;
  defaultShare: number;
  costPerM: number;
  costHorizon: number;
  vsBest: number | null;
  scores: Scores;
  verdict: ClassifiedEndpoint["cls"];
  reasons: string[];
  eligible: boolean;
  presetRank: number | null;
  ban: BanStatus;
};

export type CostTriple = { default: number | null; bans: number | null; preset: number | null };

export type ModelView = {
  slug: string;
  name: string;
  source: ModelInput["source"];
  usageUsd: number;
  h: number;
  r: number;
  profile: Profile;
  counts: { ok: number; outlier: number; hardBad: number };
  presetId: string;
  cost: CostTriple;
  scenarios: ({ name: string; tools: boolean; h: number; r: number } & CostTriple)[];
  endpoints: EndpointView[];
  warnings: string[];
};

export type Overview = {
  takenAt: string;
  horizonDays: number;
  scenario: { name: string; tokensPerDay: number; tools: boolean | null; h: number | null; r: number | null };
  scenarios: string[];
  summary: { default: number; bans: number; presets: number; riskShare: number };
  models: ModelView[];
};

const QUANT_NAMES = ["int4", "fp4", "fp6", "int8", "fp8", "fp16", "bf16", "fp32"];
const DEFAULT_SCENARIO = "actual";

export function viewSettings(settings: Settings, q: ViewQuery): Settings {
  return {
    ...settings,
    filters: {
      ...settings.filters,
      minQuantization: q.minQuantization ?? settings.filters.minQuantization,
      minUptime: q.minUptime ?? settings.filters.minUptime,
    },
  };
}

export function scenarioNames(settings: Settings): string[] {
  return [DEFAULT_SCENARIO, ...settings.scenarios.profiles.map((p) => p.name), "custom"];
}

export function resolveProfile(model: ModelInput, settings: Settings, q: ViewQuery): Profile {
  const perDay = q.tokensPerDay ?? settings.scenarios.inputTokensPerDay;
  if (q.scenario === "custom") {
    return { name: "custom", h: q.h ?? settings.defaultProfile.h, r: q.r ?? settings.defaultProfile.r, tools: q.tools ?? false, inputPerDay: perDay, estimated: false };
  }
  const named = settings.scenarios.profiles.find((p) => p.name === q.scenario);
  if (named) return { name: named.name, h: named.h, r: named.r, tools: named.tools, inputPerDay: perDay, estimated: false };
  const actual = model.inputTokens / settings.usageWindowDays;
  return {
    name: DEFAULT_SCENARIO,
    h: model.h,
    r: model.r,
    tools: q.tools ?? false,
    inputPerDay: actual > 0 ? actual : perDay,
    estimated: actual <= 0,
  };
}

export function desiredBans(inputs: BanInputs): Set<string> {
  const out = new Set<string>();
  for (const [p, policy] of inputs.policies) if (policy === "ban") out.add(p);
  for (const s of inputs.states.values()) if (s.autoBanned && inputs.policies.get(s.provider) !== "allow") out.add(s.provider);
  return out;
}

export function fixedBans(inputs: BanInputs): Set<string> {
  return new Set([...inputs.policies].filter(([, v]) => v === "ban").map(([k]) => k));
}

export function allowedProviders(inputs: BanInputs): Set<string> {
  return new Set([...inputs.policies].filter(([, v]) => v === "allow").map(([k]) => k));
}

export function currentBans(snapshot: AppSnapshot): Set<string> {
  return new Set((snapshot.guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
}

function banStatus(provider: string, inputs: BanInputs, current: Set<string>, desired: Set<string>, settings: Settings): BanStatus {
  const s = inputs.states.get(provider);
  const { banAfterRuns, unbanAfterRuns } = settings.optimizer.hysteresis;
  let pending: BanStatus["pending"] = null;
  if (s && !s.autoBanned && s.banStreak > 0) pending = { action: "ban", streak: s.banStreak, needed: banAfterRuns };
  if (s && s.autoBanned && s.cleanStreak > 0) pending = { action: "unban", streak: s.cleanStreak, needed: unbanAfterRuns };
  return {
    policy: inputs.policies.get(provider) ?? null,
    auto: Boolean(s?.autoBanned),
    inGuardrail: current.has(provider),
    inDesired: desired.has(provider),
    pending,
  };
}

const clamp = (v: number, lo = 0, hi = 1) => Math.min(Math.max(v, lo), hi);
const round = (v: number) => Math.round(v * 10) / 10;

export function scoreEndpoints(
  endpoints: ClassifiedEndpoint[],
  profile: Profile,
  pool: ClassifiedEndpoint[],
  weights: { price: number; speed: number; reliability: number },
): Map<ClassifiedEndpoint, Scores> {
  const base = pool.length > 0 ? pool : endpoints;
  const costs = base.map((e) => unitCost(e, profile.h, profile.r)).filter((c) => c > 0);
  const minCost = costs.length ? Math.min(...costs) : 0;
  const maxTps = Math.max(0, ...base.map((e) => e.tps ?? 0));
  const lats = base.map((e) => e.latencyMs).filter((v): v is number => v !== null && v > 0);
  const minLat = lats.length ? Math.min(...lats) : 0;
  const total = weights.price + weights.speed + weights.reliability || 1;
  const out = new Map<ClassifiedEndpoint, Scores>();
  for (const e of endpoints) {
    const cost = unitCost(e, profile.h, profile.r);
    const price = cost <= 0 ? 100 : minCost > 0 ? clamp(minCost / cost) * 100 : 0;
    const tpsPart = e.tps !== null && maxTps > 0 ? clamp(e.tps / maxTps) : 0.3;
    const latPart = e.latencyMs !== null && e.latencyMs > 0 && minLat > 0 ? clamp(minLat / e.latencyMs) : 0.3;
    const speed = (0.7 * tpsPart + 0.3 * latPart) * 100;
    const uptime = e.uptime30m === null ? e.uptime : 0.8 * e.uptime + 0.2 * e.uptime30m;
    const reliability = clamp((uptime - 0.9) / 0.1) * 100;
    const overall = (price * weights.price + speed * weights.speed + reliability * weights.reliability) / total;
    out.set(e, { price: round(price), speed: round(speed), reliability: round(reliability), overall: round(overall) });
  }
  return out;
}

export function isEligible(e: ClassifiedEndpoint, profile: Profile, banned: ReadonlySet<string>, zdrOnly: boolean): boolean {
  return e.cls === "ok" && (!profile.tools || e.tools) && (!zdrOnly || e.zdr) && !banned.has(e.provider);
}

export function rankForPreset(
  model: ClassifiedModel,
  profile: Profile,
  banned: ReadonlySet<string>,
  scores: Map<ClassifiedEndpoint, Scores>,
  preset: PresetSettings | undefined,
  topN: number,
  zdrOnly: boolean,
): ClassifiedEndpoint[] {
  const excluded = new Set(preset?.excluded ?? []);
  const eligible = model.endpoints.filter((e) => isEligible(e, profile, banned, zdrOnly) && !excluded.has(e.tag));
  const pinned = (preset?.pinned ?? []).map((t) => eligible.find((e) => e.tag === t)).filter((e): e is ClassifiedEndpoint => Boolean(e));
  const rest = eligible
    .filter((e) => !pinned.includes(e))
    .sort((a, b) => scores.get(b)!.overall - scores.get(a)!.overall || a.tag.localeCompare(b.tag));
  const seen = new Set<string>();
  return [...pinned, ...rest].filter((e) => !seen.has(e.tag) && Boolean(seen.add(e.tag))).slice(0, topN);
}

export function orderedPrice(ranked: ClassifiedEndpoint[], h: number, r: number): number | null {
  if (ranked.length === 0) return null;
  let reach = 1;
  let weight = 0;
  let total = 0;
  for (const e of ranked) {
    const served = reach * e.uptime;
    weight += served;
    total += served * unitCost(e, h, r);
    reach *= 1 - e.uptime;
  }
  return weight > 0 ? total / weight : null;
}

export function routingShares(model: ClassifiedModel, banned: ReadonlySet<string>, tools: boolean, settings: Settings): Map<ClassifiedEndpoint, number> {
  const live = model.endpoints.filter((e) => !banned.has(e.provider) && (!tools || e.tools));
  const total = live.reduce((s, e) => s + e.weight, 0);
  return new Map(model.endpoints.map((e) => [e, total > 0 && live.includes(e) ? e.weight / total : 0]));
}

export function presetSlug(model: string, settings: Settings, preset?: PresetSettings): string {
  if (preset?.slug) return preset.slug;
  const base = model.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  return settings.presets.slugPattern.replace("{model}", base);
}

export function allowedQuantizations(slug: string, settings: Settings): string[] {
  const min = modelMinQuantRank(slug, settings);
  return QUANT_NAMES.filter((q) => quantRank(q) >= min);
}

export function presetConfig(model: ClassifiedModel, ranked: ClassifiedEndpoint[], profile: Profile, settings: Settings) {
  const tags = ranked.map((e) => e.tag);
  return {
    model: model.slug,
    provider: {
      order: tags,
      only: tags,
      allow_fallbacks: true,
      quantizations: allowedQuantizations(model.slug, settings),
      ...(profile.tools ? { require_parameters: true } : {}),
    },
  };
}

export function configHash(config: unknown): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)]))
        : v;
  return createHash("sha256").update(JSON.stringify(stable(config))).digest("hex").slice(0, 16);
}

export function remoteConfigHash(config: Record<string, unknown> | undefined): string | null {
  if (!config) return null;
  return configHash({ model: config.model, provider: config.provider });
}

type Ctx = {
  snapshot: AppSnapshot;
  settings: Settings;
  q: ViewQuery;
  bans: BanInputs;
  presets: ReadonlyMap<string, PresetSettings>;
};

type ModelCalc = {
  model: ClassifiedModel;
  profile: Profile;
  scores: Map<ClassifiedEndpoint, Scores>;
  ranked: ClassifiedEndpoint[];
  shares: Map<ClassifiedEndpoint, number>;
};

function calcModel(input: ModelInput, ctx: Ctx, vs: Settings, current: Set<string>, desired: Set<string>): ModelCalc {
  const model = classifyModel(input, vs);
  const profile = resolveProfile(input, ctx.settings, ctx.q);
  const zdrOnly = ctx.q.zdrOnly ?? false;
  const weights = {
    price: ctx.q.wPrice ?? ctx.settings.scoring.price,
    speed: ctx.q.wSpeed ?? ctx.settings.scoring.speed,
    reliability: ctx.q.wReliability ?? ctx.settings.scoring.reliability,
  };
  const pool = model.endpoints.filter((e) => isEligible(e, profile, desired, zdrOnly));
  const scores = scoreEndpoints(model.endpoints, profile, pool, weights);
  const ranked = rankForPreset(model, profile, desired, scores, ctx.presets.get(model.slug), ctx.settings.presets.topN, zdrOnly);
  return { model, profile, scores, ranked, shares: routingShares(model, current, profile.tools, ctx.settings) };
}

function costs(calc: ModelCalc, current: Set<string>, desired: Set<string>, h: number, r: number, tools: boolean, perDay: number, days: number, settings: Settings): CostTriple {
  const toMoney = (perM: number | null) => (perM === null ? null : (perM * perDay * days) / 1_000_000);
  const mode = settings.optimizer.routingPrice;
  return {
    default: toMoney(pricePerMillion(calc.model, current, h, r, tools, mode).price),
    bans: toMoney(pricePerMillion(calc.model, desired, h, r, tools, mode).price),
    preset: toMoney(orderedPrice(calc.ranked, h, r)),
  };
}

export function buildOverview(ctx: Ctx): Overview {
  const { snapshot, settings, q } = ctx;
  const vs = viewSettings(settings, q);
  const days = q.days ?? settings.scenarios.days;
  const current = currentBans(snapshot);
  const desired = desiredBans(ctx.bans);
  const summary = { default: 0, bans: 0, presets: 0, riskShare: 0 };
  let riskVolume = 0;
  let volume = 0;

  const models: ModelView[] = snapshot.models.map((input) => {
    const calc = calcModel(input, ctx, vs, current, desired);
    const { model, profile, scores, ranked, shares } = calc;
    const cost = costs(calc, current, desired, profile.h, profile.r, profile.tools, profile.inputPerDay, days, settings);
    summary.default += cost.default ?? 0;
    summary.bans += cost.bans ?? 0;
    summary.presets += cost.preset ?? cost.bans ?? 0;
    const risky = model.endpoints.reduce((s, e) => s + (e.quant !== "ok" ? shares.get(e)! : 0), 0);
    riskVolume += risky * profile.inputPerDay;
    volume += profile.inputPerDay;

    const eligibleCosts = ranked.map((e) => unitCost(e, profile.h, profile.r));
    const best = eligibleCosts.length ? Math.min(...eligibleCosts) : null;
    const quantOk = model.endpoints.filter((e) => e.quant === "ok");
    const medOut = median((quantOk.length ? quantOk : model.endpoints).map((e) => e.pOut));
    const endpoints = model.endpoints
      .map((e): EndpointView => {
        const costPerM = unitCost(e, profile.h, profile.r);
        const rank = ranked.indexOf(e);
        return {
          tag: e.tag,
          provider: e.provider,
          providerName: e.providerName,
          quantization: e.quantization,
          quant: e.quant,
          zdr: e.zdr,
          tools: e.tools,
          pIn: e.pIn,
          pOut: e.pOut,
          pCache: e.pCache,
          cacheKnown: e.cacheKnown,
          cacheDiscount: e.cacheKnown && e.pIn > 0 ? 1 - e.pCache / e.pIn : null,
          outVsMedian: medOut > 0 ? e.pOut / medOut : null,
          uptime: e.uptime,
          uptime30m: e.uptime30m,
          tps: e.tps,
          latencyMs: e.latencyMs,
          defaultShare: shares.get(e) ?? 0,
          costPerM,
          costHorizon: (costPerM * profile.inputPerDay * days) / 1_000_000,
          vsBest: best && best > 0 ? costPerM / best - 1 : null,
          scores: scores.get(e)!,
          verdict: e.cls,
          reasons: e.reasons,
          eligible: isEligible(e, profile, desired, q.zdrOnly ?? false),
          presetRank: rank >= 0 ? rank + 1 : null,
          ban: banStatus(e.provider, ctx.bans, current, desired, settings),
        };
      })
      .filter((e) => !q.hideBanned || !e.ban.inDesired)
      .sort((a, b) => (a.presetRank ?? 99) - (b.presetRank ?? 99) || b.scores.overall - a.scores.overall);

    const scenarioRows = [
      { name: DEFAULT_SCENARIO, tools: false, h: input.h, r: input.r },
      ...settings.scenarios.profiles.map((p) => ({ name: p.name, tools: p.tools, h: p.h, r: p.r })),
    ].map((s) => {
      const p = resolveProfile(input, settings, { ...q, scenario: s.name });
      const sCalc = s.name === profile.name ? calc : { ...calc, ranked: rankForPreset(model, p, desired, scoreEndpoints(model.endpoints, p, model.endpoints.filter((e) => isEligible(e, p, desired, q.zdrOnly ?? false)), settings.scoring), ctx.presets.get(model.slug), settings.presets.topN, q.zdrOnly ?? false) };
      return { ...s, ...costs(sCalc, current, desired, p.h, p.r, p.tools, p.inputPerDay, days, settings) };
    });

    const warnings: string[] = [];
    const k = settings.optimizer.minEndpointsPerModel;
    if (ranked.length === 0) warnings.push("No endpoint passes the quality rules: a preset cannot be built.");
    else if (admissibleCount(model, desired) < Math.min(k, admissibleCount(model, new Set()))) {
      warnings.push(`Fewer than ${k} good providers remain after global bans.`);
    }
    if (totalCount(model, desired) === 0) warnings.push("Global bans leave this model without providers.");
    if (profile.estimated) warnings.push("No traffic in the usage window: volume uses the default tokens per day.");

    return {
      slug: model.slug,
      name: input.name,
      source: input.source,
      usageUsd: input.usageUsd,
      h: input.h,
      r: input.r,
      profile,
      counts: {
        ok: model.endpoints.filter((e) => e.cls === "ok").length,
        outlier: model.endpoints.filter((e) => e.cls === "outlier").length,
        hardBad: model.endpoints.filter((e) => e.cls === "hard-bad").length,
      },
      presetId: `@preset/${presetSlug(model.slug, settings, ctx.presets.get(model.slug))}`,
      cost,
      scenarios: scenarioRows,
      endpoints,
      warnings,
    };
  });

  models.sort((a, b) => (b.cost.default ?? 0) - (a.cost.default ?? 0) || a.slug.localeCompare(b.slug));
  summary.riskShare = volume > 0 ? riskVolume / volume : 0;
  const named = settings.scenarios.profiles.find((p) => p.name === q.scenario);
  return {
    takenAt: snapshot.takenAt,
    horizonDays: days,
    scenario: {
      name: q.scenario,
      tokensPerDay: q.tokensPerDay ?? settings.scenarios.inputTokensPerDay,
      tools: q.scenario === "custom" ? (q.tools ?? false) : named ? named.tools : null,
      h: q.scenario === "custom" ? (q.h ?? null) : named ? named.h : null,
      r: q.scenario === "custom" ? (q.r ?? null) : named ? named.r : null,
    },
    scenarios: scenarioNames(settings),
    summary,
    models,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export type ProviderRow = {
  provider: string;
  name: string;
  ban: BanStatus;
  inTarget: boolean;
  models: { slug: string; name: string; tags: string[]; verdict: ClassifiedEndpoint["cls"]; quantization: string[]; reasons: string[] }[];
  worst: string | null;
  effect: number | null;
  effectPct: number | null;
  blocked: boolean;
  breaks: string[];
};

export type ProvidersView = {
  takenAt: string;
  horizonDays: number;
  mode: Settings["mode"];
  rows: ProviderRow[];
  pending: { current: string[]; desired: string[]; added: string[]; removed: string[]; violations: Violation[] };
};

const SEVERITY: Record<ClassifiedEndpoint["cls"], number> = { "hard-bad": 2, outlier: 1, ok: 0 };

export function buildProviders(ctx: Ctx): ProvidersView {
  const { snapshot, settings, q } = ctx;
  const vs = viewSettings(settings, q);
  const days = q.days ?? settings.scenarios.days;
  const current = currentBans(snapshot);
  const desired = desiredBans(ctx.bans);
  const fixed = fixedBans(ctx.bans);
  const models = snapshot.models.map((m) => classifyModel(m, vs));
  const profiles = new Map(snapshot.models.map((m) => [m.slug, resolveProfile(m, settings, q)]));
  const target = optimize(models, fixed, vs, allowedProviders(ctx.bans)).target;
  const k = settings.optimizer.minEndpointsPerModel;
  const spend = (banned: ReadonlySet<string>) => {
    let total = 0;
    for (const m of models) {
      const p = profiles.get(m.slug)!;
      const price = pricePerMillion(m, banned, p.h, p.r, p.tools, settings.optimizer.routingPrice).price;
      if (price === null) return null;
      total += (price * p.inputPerDay * days) / 1_000_000;
    }
    return total;
  };

  const names = new Map<string, string>();
  for (const m of models) for (const e of m.endpoints) if (!names.has(e.provider)) names.set(e.provider, e.providerName);
  const all = [...new Set([...names.keys(), ...current, ...desired, ...ctx.bans.policies.keys()])].sort();

  const rows: ProviderRow[] = all.map((provider) => {
    const without = new Set(desired);
    without.delete(provider);
    const withBan = new Set([...without, provider]);
    const base = spend(without);
    const banned = spend(withBan);
    const perModel = models
      .filter((m) => m.endpoints.some((e) => e.provider === provider))
      .map((m) => {
        const eps = m.endpoints.filter((e) => e.provider === provider);
        const worst = eps.reduce((a, b) => (SEVERITY[b.cls] > SEVERITY[a.cls] ? b : a));
        return {
          slug: m.slug,
          name: snapshot.models.find((x) => x.slug === m.slug)?.name ?? m.slug,
          tags: eps.map((e) => e.tag),
          verdict: worst.cls,
          quantization: [...new Set(eps.map((e) => e.quantization))],
          reasons: [...new Set(eps.flatMap((e) => e.reasons))],
        };
      });
    const worstModel = perModel.reduce<(typeof perModel)[number] | null>((a, b) => (!a || SEVERITY[b.verdict] > SEVERITY[a.verdict] ? b : a), null);
    const breaks = violations(models, fixed, new Set([...withBan].filter((p) => !fixed.has(p))), k).map((v) => v.slug);
    return {
      provider,
      name: names.get(provider) ?? provider,
      ban: banStatus(provider, ctx.bans, current, desired, settings),
      inTarget: target.has(provider),
      models: perModel,
      worst: worstModel && worstModel.reasons.length ? `${worstModel.reasons[0]} (${worstModel.name})` : null,
      effect: base === null || banned === null ? null : banned - base,
      effectPct: base === null || banned === null || base === 0 ? null : (banned - base) / base,
      blocked: banned === null,
      breaks,
    };
  });

  rows.sort((a, b) => (a.effect ?? Infinity) - (b.effect ?? Infinity) || a.provider.localeCompare(b.provider));
  const cur = [...current].sort();
  const des = [...desired].sort();
  return {
    takenAt: snapshot.takenAt,
    horizonDays: days,
    mode: settings.mode,
    rows,
    pending: {
      current: cur,
      desired: des,
      added: des.filter((p) => !current.has(p)),
      removed: cur.filter((p) => !desired.has(p)),
      violations: violations(models, fixed, new Set(des.filter((p) => !fixed.has(p))), k),
    },
  };
}

export type RemotePreset = { hash: string | null; version: number | null; updatedAt: string | null } | null;

export type PresetView = {
  model: string;
  name: string;
  slug: string;
  presetId: string;
  profile: Profile;
  autoSync: boolean;
  pinned: string[];
  excluded: string[];
  ranked: { rank: number; tag: string; provider: string; providerName: string; quantization: string; costPerM: number; uptime: number; tps: number | null; overall: number }[];
  eligibleCount: number;
  policy: { quantizations: string[]; zdr: boolean; tools: boolean; fallbacks: boolean };
  cost: { default: number | null; preset: number | null; saving: number | null; savingPct: number | null };
  config: ReturnType<typeof presetConfig>;
  hash: string;
  status: "empty" | "not-created" | "up-to-date" | "out-of-date" | "unknown";
  remote: RemotePreset;
  syncedAt: string | null;
};

export function buildPresets(ctx: Ctx, remote: ReadonlyMap<string, RemotePreset>): PresetView[] {
  const { snapshot, settings, q } = ctx;
  const vs = viewSettings(settings, q);
  const days = q.days ?? settings.scenarios.days;
  const current = currentBans(snapshot);
  const desired = desiredBans(ctx.bans);
  return snapshot.models
    .filter((m) => new Set(m.endpoints.map((e) => e.provider)).size > 1)
    .map((input) => {
      const preset = ctx.presets.get(input.slug);
      const scenario = preset?.scenario ?? (q.scenario || settings.presets.defaultScenario);
      const calc = calcModel(input, { ...ctx, q: { ...q, scenario } }, vs, current, desired);
      const { model, profile, ranked, scores } = calc;
      const slug = presetSlug(model.slug, settings, preset);
      const config = presetConfig(model, ranked, profile, settings);
      const hash = configHash(config);
      const money = costs(calc, current, desired, profile.h, profile.r, profile.tools, profile.inputPerDay, days, settings);
      const r = remote.has(slug) ? remote.get(slug)! : undefined;
      const status: PresetView["status"] =
        ranked.length === 0 ? "empty" : r === undefined ? "unknown" : r === null ? "not-created" : r.hash === hash || preset?.syncedHash === hash ? "up-to-date" : "out-of-date";
      return {
        model: model.slug,
        name: input.name,
        slug,
        presetId: `@preset/${slug}`,
        profile,
        autoSync: preset?.autoSync ?? false,
        pinned: preset?.pinned ?? [],
        excluded: preset?.excluded ?? [],
        ranked: ranked.map((e, i) => ({
          rank: i + 1,
          tag: e.tag,
          provider: e.provider,
          providerName: e.providerName,
          quantization: e.quantization,
          costPerM: unitCost(e, profile.h, profile.r),
          uptime: e.uptime,
          tps: e.tps,
          overall: scores.get(e)!.overall,
        })),
        eligibleCount: model.endpoints.filter((e) => isEligible(e, profile, desired, q.zdrOnly ?? false)).length,
        policy: { quantizations: config.provider.quantizations, zdr: ranked.length > 0 && ranked.every((e) => e.zdr), tools: profile.tools, fallbacks: true },
        cost: {
          default: money.default,
          preset: money.preset,
          saving: money.default !== null && money.preset !== null ? money.preset - money.default : null,
          savingPct: money.default && money.preset !== null ? (money.preset - money.default) / money.default : null,
        },
        config,
        hash,
        status,
        remote: r ?? null,
        syncedAt: preset?.syncedAt ?? null,
      };
    });
}

export type HistoryEntry = RunRecord & { added: string[]; removed: string[] };

export function historyEntries(runs: RunRecord[]): HistoryEntry[] {
  return runs.map((r) => ({
    ...r,
    added: r.ignoredAfter.filter((p) => !r.ignoredBefore.includes(p)),
    removed: r.ignoredBefore.filter((p) => !r.ignoredAfter.includes(p)),
  }));
}
