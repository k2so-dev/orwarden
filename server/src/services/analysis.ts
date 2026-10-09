import { createHash } from "node:crypto";
import { classifyModel, modelMinQuantization, modelMinQuantRank, quantRank } from "../core/classify.ts";
import { routingWeight, unitCost } from "../core/cost.ts";
import { pricePerMillion } from "../core/forecast.ts";
import type { ProviderState } from "../core/hysteresis.ts";
import { CHANGE_THRESHOLD, isSignificant, priceChanges, type PriceChange } from "../core/changes.ts";
import { calibrate, confidenceOf, presetEstimate, workloadDrift, type Calibration, type Confidence, type Estimate } from "../core/estimate.ts";
import { endpointStability, NEUTRAL_STABILITY, type HistoryInputs, type Stability } from "../core/stability.ts";
import type { Guardrail } from "../core/openrouter.ts";
import { admissibleCount, optimize, totalCount, violations, type Violation } from "../core/optimizer.ts";
import type { ClassifiedEndpoint, ClassifiedModel, Issue, ModelInput } from "../core/types.ts";
import { HISTORY_DAYS, type Policy, type PresetSettings, type PriceEvent, type RunRecord } from "../db.ts";
import { PRESET_SLUG_RE, type Settings } from "../settings.ts";

export type AppSnapshot = {
  takenAt: string;
  workspace: { id: string; name: string; guardrailId: string };
  workspaces?: { id: string; name: string }[];
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
  wStability?: number;
};

export type BanInputs = {
  policies: ReadonlyMap<string, Policy>;
  states: ReadonlyMap<string, ProviderState>;
};

export type Profile = { name: string; h: number; r: number; tools: boolean; inputPerDay: number; estimated: boolean };

export type Scores = { price: number; speed: number; reliability: number; stability: number; overall: number };

export type BanStatus = {
  policy: Policy | null;
  auto: boolean;
  inGuardrail: boolean;
  inDesired: boolean;
  pending: { action: "ban" | "unban"; streak: number; needed: number } | null;
};

export type EndpointView = {
  tag: string;
  slot: number;
  provider: string;
  providerName: string;
  quantization: string;
  quant: ClassifiedEndpoint["quant"];
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
  stability: Stability;
  verdict: ClassifiedEndpoint["cls"];
  reasons: string[];
  issues: Issue[];
  eligible: boolean;
  presetRank: number | null;
  ban: BanStatus;
};

export type CostTriple = { default: number | null; bans: number | null; preset: number | null };

export type ModelView = {
  slug: string;
  name: string;
  source: ModelInput["source"];
  openWeights: boolean;
  usageUsd: number;
  h: number;
  r: number;
  profile: Profile;
  counts: { ok: number; outlier: number; hardBad: number };
  presetId: string | null;
  cost: CostTriple;
  estimate: Estimate | null;
  calibration: Calibration | null;
  scenarios: ({ name: string; tools: boolean; h: number; r: number; inputPerDay: number } & CostTriple)[];
  endpoints: EndpointView[];
  warnings: Warning[];
};

export type Warning = { level: "bad" | "warn"; title: string; text: string };

export type Overview = {
  takenAt: string;
  horizonDays: number;
  usageDays: number;
  scenario: { name: string; tokensPerDay: number; tools: boolean | null; h: number | null; r: number | null };
  scenarios: string[];
  summary: { default: number; bans: number; presets: number; presetsLow: number; presetsHigh: number; confidence: Confidence; riskShare: number };
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
      zdrOnly: q.zdrOnly ?? settings.filters.zdrOnly,
    },
  };
}

export function savedQuery(settings: Settings): ViewQuery {
  const w = settings.workload;
  const custom = w.mode === "custom";
  return {
    scenario: custom ? "custom" : DEFAULT_SCENARIO,
    ...(custom ? { h: w.h, r: w.r, tokensPerDay: w.tokensPerDay } : {}),
    tools: settings.filters.requireTools,
  };
}

export function resolveQuery(settings: Settings, raw: Partial<ViewQuery> = {}): ViewQuery {
  const defined = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  return { ...savedQuery(settings), ...defined };
}

export function hasPreset(input: Pick<ModelInput, "endpoints">): boolean {
  return new Set(input.endpoints.map((e) => e.provider)).size > 1;
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
    inputPerDay: q.tokensPerDay ?? (actual > 0 ? actual : perDay),
    estimated: q.tokensPerDay === undefined && actual <= 0,
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
  weights: { price: number; speed: number; reliability: number; stability?: number; unknownQuantPenalty?: number },
  stability?: ReadonlyMap<ClassifiedEndpoint, Stability>,
): Map<ClassifiedEndpoint, Scores> {
  const base = pool.length > 0 ? pool : endpoints;
  const costs = base.map((e) => unitCost(e, profile.h, profile.r)).filter((c) => c > 0);
  const minCost = costs.length ? Math.min(...costs) : 0;
  const maxTps = Math.max(0, ...base.map((e) => e.tps ?? 0));
  const lats = base.map((e) => e.latencyMs).filter((v): v is number => v !== null && v > 0);
  const minLat = lats.length ? Math.min(...lats) : 0;
  const wStability = weights.stability ?? 0;
  const total = weights.price + weights.speed + weights.reliability + wStability || 1;
  const out = new Map<ClassifiedEndpoint, Scores>();
  for (const e of endpoints) {
    const cost = unitCost(e, profile.h, profile.r);
    const price = cost <= 0 ? 100 : minCost > 0 ? clamp(minCost / cost) * 100 : 0;
    const tpsPart = e.tps !== null && maxTps > 0 ? clamp(e.tps / maxTps) : 0.3;
    const latPart = e.latencyMs !== null && e.latencyMs > 0 && minLat > 0 ? clamp(minLat / e.latencyMs) : 0.3;
    const speed = (0.7 * tpsPart + 0.3 * latPart) * 100;
    const uptime = e.uptime30m === null ? e.uptime : 0.8 * e.uptime + 0.2 * e.uptime30m;
    const reliability = clamp((uptime - 0.9) / 0.1) * 100;
    const penalty = e.quant === "unknown" ? (weights.unknownQuantPenalty ?? 0) : 0;
    const steady = (stability?.get(e) ?? NEUTRAL_STABILITY).score;
    const overall = Math.max(0, (price * weights.price + speed * weights.speed + reliability * weights.reliability + steady * wStability) / total - penalty);
    out.set(e, { price: round(price), speed: round(speed), reliability: round(reliability), stability: round(steady), overall: round(overall) });
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
  rankBy: Settings["presets"]["rankBy"] = "score",
  maxPremium = Number.POSITIVE_INFINITY,
): ClassifiedEndpoint[] {
  const excluded = new Set(preset?.excluded ?? []);
  const eligible = model.endpoints.filter((e) => isEligible(e, profile, banned, zdrOnly) && !excluded.has(e.tag));
  const byScore = (a: ClassifiedEndpoint, b: ClassifiedEndpoint) => scores.get(b)!.overall - scores.get(a)!.overall || a.tag.localeCompare(b.tag);
  if (preset?.picked) {
    const picked = new Set(preset.picked);
    return eligible.filter((e) => picked.has(e.tag)).sort(byScore);
  }
  const pinned = (preset?.pinned ?? []).map((t) => eligible.find((e) => e.tag === t)).filter((e): e is ClassifiedEndpoint => Boolean(e));
  const rest = eligible
    .filter((e) => !pinned.includes(e))
    .sort(
      (a, b) =>
        (rankBy === "cost" ? effectivePerM(a, profile) - effectivePerM(b, profile) : 0) ||
        scores.get(b)!.overall - scores.get(a)!.overall ||
        a.tag.localeCompare(b.tag),
    );
  const seen = new Set<string>();
  const top = [...pinned, ...rest].filter((e) => !seen.has(e.tag) && Boolean(seen.add(e.tag))).slice(0, topN);
  const free = top.filter((e) => !pinned.includes(e));
  if (free.length === 0) return top;
  const ceiling = Math.min(...free.map((e) => effectivePerM(e, profile))) * (1 + maxPremium);
  return top.filter((e) => pinned.includes(e) || effectivePerM(e, profile) <= ceiling * (1 + 1e-9));
}

export function effectivePerM(e: ClassifiedEndpoint, profile: { h: number; r: number }): number {
  return unitCost(e, profile.h, profile.r) / Math.max(e.uptime, 0.01);
}

export function presetPrice(ranked: readonly ClassifiedEndpoint[], h: number, r: number): number | null {
  return ranked.length === 0 ? null : Math.max(...ranked.map((e) => unitCost(e, h, r)));
}

export function servable<T extends { tools: boolean }>(ranked: readonly T[], tools: boolean): T[] {
  return tools ? ranked.filter((e) => e.tools) : [...ranked];
}

export function routingShares(model: ClassifiedModel, banned: ReadonlySet<string>, profile: Pick<Profile, "h" | "r" | "tools">, settings: Settings): Map<ClassifiedEndpoint, number> {
  const live = model.endpoints.filter((e) => !banned.has(e.provider) && (!profile.tools || e.tools));
  const weight = (e: ClassifiedEndpoint) => routingWeight(e, profile.h, profile.r, settings.optimizer.routingPrice);
  const total = live.reduce((s, e) => s + weight(e), 0);
  return new Map(model.endpoints.map((e) => [e, total > 0 && live.includes(e) ? weight(e) / total : 0]));
}

const slugPart = (s: string) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const MAX_SLUG = 63;

function fitSlug(slug: string): string {
  if (slug.length > MAX_SLUG) {
    const tail = createHash("sha256").update(slug).digest("hex").slice(0, 6);
    slug = `${slug.slice(0, MAX_SLUG - 7).replace(/-+$/, "")}-${tail}`;
  }
  return PRESET_SLUG_RE.test(slug) ? slug : fitSlug(`preset-${slug.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "")}`);
}

function applyPattern(settings: Settings, base: string): string {
  const pattern = settings.presets.slugPattern;
  return pattern.includes("{model}") ? pattern.replace("{model}", base) : `${base}-${pattern}`;
}

export function trackedSlugs(models: readonly ModelInput[], settings: Settings, presets: ReadonlyMap<string, PresetSettings>): Map<string, string> {
  return presetSlugs(models.filter(hasPreset).map((m) => m.slug), settings, presets);
}

export function legacySlug(model: string, settings: Settings): string {
  return applyPattern(settings, slugPart(model.split("/").pop()!));
}

export function presetSlugs(models: readonly string[], settings: Settings, presets: ReadonlyMap<string, PresetSettings>): Map<string, string> {
  const pattern = (base: string) => applyPattern(settings, base);
  const short = (m: string) => slugPart(m.split("/").pop()!);
  const all = [...new Set(models)].sort();
  const stored = [...presets].sort(([a], [b]) => a.localeCompare(b));
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const [m, p] of stored) {
    if (p.slug && !taken.has(p.slug)) {
      taken.add(p.slug);
      out.set(m, p.slug);
    }
  }
  for (const [m, p] of stored) {
    const legacy = legacySlug(m, settings);
    if (!out.has(m) && !p.slug && p.syncedAt && !taken.has(legacy)) {
      taken.add(legacy);
      out.set(m, legacy);
    }
  }
  const counts = new Map<string, number>();
  for (const m of all) counts.set(short(m), (counts.get(short(m)) ?? 0) + 1);
  for (const m of all) {
    if (out.has(m)) continue;
    let slug = fitSlug((counts.get(short(m)) ?? 0) > 1 || taken.has(fitSlug(pattern(short(m)))) ? pattern(slugPart(m)) : pattern(short(m)));
    for (let n = 2; taken.has(slug); n++) slug = fitSlug(pattern(`${slugPart(m)}-${n}`));
    taken.add(slug);
    out.set(m, slug);
  }
  return new Map(all.map((m) => [m, out.get(m)!]));
}

export function allowedQuantizations(slug: string, settings: Settings): string[] {
  const min = modelMinQuantRank(slug, settings);
  return QUANT_NAMES.filter((q) => quantRank(q) >= min);
}

export function presetConfig(model: ClassifiedModel, ranked: readonly Pick<ClassifiedEndpoint, "tag" | "quantization">[], profile: Pick<Profile, "tools">, settings: Settings) {
  const tags = ranked.map((e) => e.tag);
  const standard = ranked.every((e) => QUANT_NAMES.includes(e.quantization.toLowerCase()));
  return {
    model: model.slug,
    provider: {
      only: tags,
      allow_fallbacks: true,
      ...(model.openWeights !== false && standard ? { quantizations: allowedQuantizations(model.slug, settings) } : {}),
      ...(profile.tools ? { require_parameters: true } : {}),
    },
  };
}

const WATCHED_PROVIDER_KEYS: Record<string, unknown> = { ignore: null, sort: null, max_price: null, data_collection: "allow", zdr: false };
const isSet = (v: unknown) =>
  v !== null &&
  v !== undefined &&
  v !== false &&
  v !== "" &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0);

function watched(provider: Record<string, unknown>) {
  return Object.entries(WATCHED_PROVIDER_KEYS)
    .filter(([k, fallback]) => isSet(provider[k]) && provider[k] !== fallback)
    .map(([k]) => [k, JSON.stringify(provider[k])]);
}

function hashable(config: Record<string, unknown>) {
  const p = (config.provider ?? {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : null);
  return {
    model: config.model ?? null,
    order: list(p.order) ?? [],
    only: [...new Set(list(p.only) ?? [])].sort(),
    fallbacks: p.allow_fallbacks !== false,
    quantizations: list(p.quantizations)?.length ? list(p.quantizations)!.map((q) => q.toLowerCase()).sort() : null,
    parameters: p.require_parameters === true,
    edits: watched(p),
  };
}

export function configHash(config: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(hashable(config))).digest("hex").slice(0, 16);
}

const WRITTEN_PROVIDER_KEYS = new Set(["order", "only", "allow_fallbacks", "quantizations", "require_parameters"]);

export function remoteEdits(version: { config?: Record<string, unknown>; system_prompt?: string | null } | null | undefined): string[] {
  const config = version?.config;
  if (!config) return ["unreadable config"];
  const provider = (config.provider ?? {}) as Record<string, unknown>;
  const out = watched(provider).map(([k]) => k!);
  for (const [k, v] of Object.entries(provider)) if (!WRITTEN_PROVIDER_KEYS.has(k) && !(k in WATCHED_PROVIDER_KEYS) && isSet(v)) out.push(k);
  for (const [k, v] of Object.entries(config)) if (k !== "model" && k !== "provider" && isSet(v)) out.push(k);
  if (isSet(version?.system_prompt)) out.push("system_prompt");
  return out;
}

export function remoteConfigHash(config: Record<string, unknown> | undefined): string | null {
  return config ? configHash(config) : null;
}

type Ctx = {
  snapshot: AppSnapshot;
  settings: Settings;
  q: ViewQuery;
  bans: BanInputs;
  presets: ReadonlyMap<string, PresetSettings>;
  history?: HistoryInputs;
};

type ModelCalc = {
  model: ClassifiedModel;
  profile: Profile;
  scores: Map<ClassifiedEndpoint, Scores>;
  stability: Map<ClassifiedEndpoint, Stability>;
  pool: ClassifiedEndpoint[];
  ranked: ClassifiedEndpoint[];
  shares: Map<ClassifiedEndpoint, number>;
};

type Basis = {
  settings: Settings;
  q: ViewQuery;
  zdrOnly: boolean;
  weights: { price: number; speed: number; reliability: number; stability: number; unknownQuantPenalty: number };
};

function viewBasis(ctx: Ctx): Basis {
  const vs = viewSettings(ctx.settings, ctx.q);
  return {
    settings: vs,
    q: ctx.q,
    zdrOnly: vs.filters.zdrOnly,
    weights: {
      price: ctx.q.wPrice ?? ctx.settings.scoring.price,
      speed: ctx.q.wSpeed ?? ctx.settings.scoring.speed,
      reliability: ctx.q.wReliability ?? ctx.settings.scoring.reliability,
      stability: ctx.q.wStability ?? ctx.settings.scoring.stability,
      unknownQuantPenalty: ctx.settings.scoring.unknownQuantPenalty,
    },
  };
}

export function presetBasis(ctx: Ctx, model: string): Basis {
  const { settings } = ctx;
  return {
    settings,
    q: savedQuery(settings),
    zdrOnly: settings.filters.zdrOnly,
    weights: { ...settings.scoring },
  };
}

function calcModel(input: ModelInput, ctx: Ctx, basis: Basis, current: Set<string>, desired: Set<string>): ModelCalc {
  const model = classifyModel(input, basis.settings);
  const profile = resolveProfile(input, ctx.settings, basis.q);
  const pool = model.endpoints.filter((e) => isEligible(e, profile, desired, basis.zdrOnly));
  const found = endpointStability(ctx.history, model.slug, model.endpoints, ctx.snapshot.takenAt, profile, basis.settings.filters.minUptime);
  const stability = new Map(model.endpoints.map((e, i) => [e, found[i]!]));
  const scores = scoreEndpoints(model.endpoints, profile, pool, basis.weights, stability);
  const ranked = rankForPreset(model, profile, desired, scores, ctx.presets.get(model.slug), ctx.settings.presets.topN, basis.zdrOnly, ctx.settings.presets.rankBy, ctx.settings.presets.maxPremium);
  return { model, profile, scores, stability, pool, ranked, shares: routingShares(model, current, profile, ctx.settings) };
}

function costs(model: ClassifiedModel, ranked: ClassifiedEndpoint[] | null, current: Set<string>, desired: Set<string>, p: Pick<Profile, "h" | "r" | "tools" | "inputPerDay">, days: number, settings: Settings): CostTriple {
  const toMoney = (perM: number | null) => (perM === null ? null : (perM * p.inputPerDay * days) / 1_000_000);
  const mode = settings.optimizer.routingPrice;
  return {
    default: toMoney(pricePerMillion(model, current, p.h, p.r, p.tools, mode).price),
    bans: toMoney(pricePerMillion(model, desired, p.h, p.r, p.tools, mode).price),
    preset: ranked ? toMoney(presetPrice(servable(ranked, p.tools), p.h, p.r)) : null,
  };
}

function modelCalibration(input: ModelInput, calc: ModelCalc, ranked: ClassifiedEndpoint[] | null, current: ReadonlySet<string>, ctx: Ctx): Calibration | null {
  if (input.source !== "usage" || input.inputTokens <= 0 || input.usageUsd <= 0) return null;
  const { settings, snapshot } = ctx;
  const days = settings.usageWindowDays;
  const windowStart = new Date(Math.floor(Date.parse(snapshot.takenAt) / 86_400_000) * 86_400_000 - days * 86_400_000).toISOString();
  const syncedAt = ctx.presets.get(input.slug)?.syncedAt ?? null;
  const tools = settings.filters.requireTools;
  const money = (perM: number) => (perM * input.inputTokens) / 1_000_000;
  const members = ranked ? servable(ranked, tools) : [];
  if (syncedAt && syncedAt <= windowStart && members.length > 0) {
    const costs = members.map((e) => unitCost(e, input.h, input.r));
    return calibrate(input.usageUsd, money(Math.min(...costs)), money(Math.max(...costs)), "preset", days);
  }
  const price = pricePerMillion(calc.model, current, input.h, input.r, tools, settings.optimizer.routingPrice).price;
  return price === null ? null : calibrate(input.usageUsd, money(price), money(price), "default", days);
}

function modelEstimate(
  input: ModelInput,
  calc: ModelCalc,
  ranked: ClassifiedEndpoint[] | null,
  current: ReadonlySet<string>,
  profile: Profile,
  days: number,
  calibration: Calibration | null = null,
): Estimate | null {
  if (!ranked) return null;
  const members = servable(ranked, profile.tools).map((e) => ({ endpoint: e, stability: calc.stability.get(e) ?? NEUTRAL_STABILITY }));
  const tokens = profile.inputPerDay * days;
  const live = calc.model.endpoints.filter((e) => !current.has(e.provider) && (!profile.tools || e.tools)).map((e) => (unitCost(e, profile.h, profile.r) * tokens) / 1_000_000);
  return presetEstimate({
    members,
    h: profile.h,
    r: profile.r,
    tokens,
    drift: profile.name === DEFAULT_SCENARIO && !profile.estimated ? workloadDrift(input.daily) : null,
    contextTokens: input.requests ? input.inputTokens / input.requests : null,
    estimated: profile.estimated,
    defaultRange: live.length > 1 ? { low: Math.min(...live), high: Math.max(...live) } : null,
    calibration,
  });
}

function emptyWarning(calc: ModelCalc, banned: ReadonlySet<string>, zdrOnly: boolean, qualityTitle: string, multi: boolean, scope: "preset" | "view"): Warning {
  const good = calc.model.endpoints.filter((e) => e.cls === "ok");
  const quantOk = calc.model.endpoints.some((e) => e.quant === "ok" || e.quant === "closed");
  const workload = scope === "preset" ? "the preset workload" : "the selected workload";
  const rules = scope === "preset" ? "the saved rules require" : "ZDR-only requires";
  if (good.length === 0) {
    const text =
      scope === "preset" ? "No endpoint passes the saved quality rules, so a safe preset cannot be built." : multi ? "No endpoint passes the quality rules in this view." : "The only provider fails the quality rules.";
    return { level: "bad", title: quantOk ? "No provider passes the quality rules." : qualityTitle, text };
  }
  const allowed = good.filter((e) => !banned.has(e.provider));
  if (allowed.length === 0) return { level: "bad", title: "All good providers are banned.", text: "Every endpoint that passes the quality rules belongs to a globally banned provider." };
  const tooled = allowed.filter((e) => !calc.profile.tools || e.tools);
  if (tooled.length === 0) {
    return { level: "bad", title: "No tool-capable provider.", text: multi ? `No endpoint that passes the rules supports tools, which ${workload} requires.` : `The only provider does not support tools, which ${workload} requires.` };
  }
  if (zdrOnly && !tooled.some((e) => e.zdr)) {
    return { level: "bad", title: "No ZDR provider.", text: multi ? `No endpoint that passes the rules offers zero data retention, which ${rules}.` : `The only provider does not offer zero data retention, which ${rules}.` };
  }
  return { level: "bad", title: "No eligible provider.", text: "No endpoint passes the rules." };
}

function presetBlocker(input: ModelInput, calc: ModelCalc, banned: ReadonlySet<string>, zdrOnly: boolean, settings: Settings): Warning | null {
  if (calc.ranked.length > 0) return null;
  if (calc.pool.length > 0) return { level: "bad", title: "Every eligible provider is excluded.", text: "All endpoints that pass the rules are excluded from this preset." };
  return emptyWarning(calc, banned, zdrOnly, qualityTitle(input, settings), true, "preset");
}

function qualityTitle(input: ModelInput, settings: Settings): string {
  return input.openWeights !== false ? `No ${modelMinQuantization(input.slug, settings)}+ provider.` : "No eligible provider.";
}

export function remoteForeign(remote: RemotePreset | undefined, model: string, syncedAt: string | null | undefined): boolean {
  if (!remote) return false;
  return !syncedAt || remote.model !== model;
}

export function remoteMatches(remote: RemotePreset | undefined, syncedHash: string | null | undefined, hash: string): boolean {
  return !!remote && (remote.hash === hash || (remote.hash === null && syncedHash === hash));
}

export function buildOverview(ctx: Ctx): Overview {
  const { snapshot, settings, q } = ctx;
  const view = viewBasis(ctx);
  const days = q.days ?? settings.scenarios.days;
  const current = currentBans(snapshot);
  const desired = desiredBans(ctx.bans);
  const slugs = trackedSlugs(snapshot.models, settings, ctx.presets);
  const summary = { default: 0, bans: 0, presets: 0, presetsLow: 0, presetsHigh: 0, confidence: "high" as Confidence, riskShare: 0 };
  const estimates: Estimate[] = [];
  let riskVolume = 0;
  let volume = 0;

  const models: ModelView[] = snapshot.models.map((input) => {
    const calc = calcModel(input, ctx, view, current, desired);
    const { model, profile, scores, pool, shares, stability } = calc;
    const basis = presetBasis(ctx, input.slug);
    const basisCalc = calcModel(input, ctx, basis, current, desired);
    const presetCalc = hasPreset(input) ? basisCalc : null;
    const presetRanked = presetCalc?.ranked ?? null;
    const presetRank = new Map((presetRanked ?? []).map((e, i) => [basisCalc.model.endpoints.indexOf(e), i + 1]));
    const cost = costs(model, presetRanked, current, desired, profile, days, settings);
    summary.default += cost.default ?? 0;
    summary.bans += cost.bans ?? cost.default ?? 0;
    summary.presets += cost.preset ?? cost.bans ?? cost.default ?? 0;
    const calibration = modelCalibration(input, basisCalc, presetRanked, current, ctx);
    const estimate = presetCalc ? modelEstimate(input, basisCalc, presetRanked, current, profile, days, calibration) : null;
    summary.presetsLow += estimate?.low ?? cost.bans ?? cost.default ?? 0;
    summary.presetsHigh += estimate?.high ?? cost.bans ?? cost.default ?? 0;
    if (estimate) estimates.push(estimate);
    const routed = model.endpoints.reduce((s, e) => s + shares.get(e)!, 0);
    if (input.openWeights !== false && routed > 0) {
      riskVolume += model.endpoints.reduce((s, e) => s + (e.quant === "low" || e.quant === "unknown" ? shares.get(e)! : 0), 0) * profile.inputPerDay;
      volume += profile.inputPerDay;
    }

    const eligibleCosts = pool.map((e) => unitCost(e, profile.h, profile.r));
    const best = eligibleCosts.length ? Math.min(...eligibleCosts) : null;
    const quantOk = model.endpoints.filter((e) => e.quant === "ok" || e.quant === "closed");
    const medOut = median((quantOk.length ? quantOk : model.endpoints).map((e) => e.pOut));
    const endpoints = model.endpoints
      .map((e, i): EndpointView => {
        const costPerM = unitCost(e, profile.h, profile.r);
        return {
          tag: e.tag,
          slot: model.endpoints.slice(0, i).filter((x) => x.tag === e.tag).length,
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
          stability: stability.get(e)!,
          verdict: e.cls,
          reasons: e.reasons,
          issues: e.issues,
          eligible: isEligible(e, profile, desired, view.zdrOnly),
          presetRank: presetRank.get(i) ?? null,
          ban: banStatus(e.provider, ctx.bans, current, desired, settings),
        };
      })
      .filter((e) => !q.hideBanned || !e.ban.inDesired)
      .sort((a, b) => (a.presetRank ?? 99) - (b.presetRank ?? 99) || b.scores.overall - a.scores.overall);

    const scenarioRows = [
      { name: DEFAULT_SCENARIO, tools: false, h: input.h, r: input.r },
      ...settings.scenarios.profiles.map((p) => ({ name: p.name, tools: p.tools, h: p.h, r: p.r })),
    ].map((s) => {
      const p = resolveProfile(input, settings, { ...q, scenario: s.name, tokensPerDay: q.tokensPerDay ?? profile.inputPerDay });
      return { ...s, h: p.h, r: p.r, tools: p.tools, inputPerDay: p.inputPerDay, ...costs(model, presetRanked, current, desired, p, days, settings) };
    });

    const warnings: Warning[] = [];
    const k = settings.optimizer.minEndpointsPerModel;
    const blocker = presetCalc ? presetBlocker(input, presetCalc, desired, basis.zdrOnly, settings) : null;
    const viewBlocker = pool.length === 0 ? emptyWarning(calc, desired, view.zdrOnly, qualityTitle(input, view.settings), presetCalc !== null, "view") : null;
    if (blocker) warnings.push(blocker);
    if (viewBlocker && viewBlocker.title !== blocker?.title) warnings.push(viewBlocker);
    if (!blocker && !viewBlocker && admissibleCount(model, desired) < Math.min(k, admissibleCount(model, new Set()))) {
      warnings.push({ level: "warn", title: `Fewer than ${k} good providers.`, text: "Global bans leave too few good endpoints for this model." });
    }
    if (totalCount(model, desired) === 0) warnings.push({ level: "bad", title: "No providers left.", text: "Global bans remove every endpoint of this model." });
    if (profile.estimated) warnings.push({ level: "warn", title: "No recent traffic.", text: "Volume uses the default tokens per day." });

    return {
      slug: model.slug,
      name: input.name,
      source: input.source,
      openWeights: input.openWeights !== false,
      usageUsd: input.usageUsd,
      h: input.h,
      r: input.r,
      profile,
      counts: {
        ok: model.endpoints.filter((e) => e.cls === "ok").length,
        outlier: model.endpoints.filter((e) => e.cls === "outlier").length,
        hardBad: model.endpoints.filter((e) => e.cls === "hard-bad").length,
      },
      presetId: presetCalc ? `@preset/${slugs.get(model.slug)!}` : null,
      cost,
      estimate,
      calibration,
      scenarios: scenarioRows,
      endpoints,
      warnings,
    };
  });

  models.sort((a, b) => (b.cost.default ?? 0) - (a.cost.default ?? 0) || a.slug.localeCompare(b.slug));
  summary.riskShare = volume > 0 ? riskVolume / volume : 0;
  summary.confidence = confidenceOf(estimates.filter((e) => e.value >= summary.presets * 0.05).flatMap((e) => e.risks));
  const named = settings.scenarios.profiles.find((p) => p.name === q.scenario);
  return {
    takenAt: snapshot.takenAt,
    horizonDays: days,
    usageDays: settings.usageWindowDays,
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

  const names = new Map<string, string>();
  for (const m of models) for (const e of m.endpoints) if (!names.has(e.provider)) names.set(e.provider, e.providerName);
  const all = [...new Set([...names.keys(), ...current, ...desired, ...ctx.bans.policies.keys()])].sort();

  const rows: ProviderRow[] = all.map((provider) => {
    const without = new Set(desired);
    without.delete(provider);
    const withBan = new Set([...without, provider]);
    const { before: base, after: banned, blocked } = costChange(models, profiles, without, withBan, days, settings);
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
      effect: blocked ? null : banned - base,
      effectPct: blocked || base === 0 ? null : (banned - base) / base,
      blocked,
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

export type RemotePreset = { hash: string | null; model: string | null; edits: string[]; version: number | null; updatedAt: string | null } | null;

export type PresetEndpoint = {
  rank: number;
  tag: string;
  provider: string;
  providerName: string;
  quantization: string;
  pIn: number;
  pOut: number;
  pCache: number;
  cacheKnown: boolean;
  costPerM: number;
  effectivePerM: number;
  costHorizon: number;
  vsCheapest: number | null;
  uptime: number;
  tps: number | null;
  overall: number;
  pinned: boolean;
  picked: boolean;
};

export type PresetScenario = { name: string; h: number; r: number; tools: boolean; inputPerDay: number; default: number | null; preset: number | null };

export type PresetView = {
  model: string;
  name: string;
  openWeights: boolean;
  slug: string;
  presetId: string;
  profile: Profile;
  horizonDays: number;
  autoSync: boolean;
  pinned: string[];
  excluded: string[];
  picked: string[] | null;
  rankBy: Settings["presets"]["rankBy"];
  ranked: PresetEndpoint[];
  cheapest: { tag: string; providerName: string; costPerM: number } | null;
  eligibleCount: number;
  policy: { quantizations: string[]; minQuantization: string | null; zdr: boolean; tools: boolean; fallbacks: boolean };
  perM: { default: number | null; preset: number | null };
  cost: { default: number | null; preset: number | null; saving: number | null; savingPct: number | null };
  estimate: Estimate | null;
  scenarios: PresetScenario[];
  config: ReturnType<typeof presetConfig>;
  hash: string;
  status: "empty" | "not-created" | "up-to-date" | "out-of-date" | "foreign" | "unknown";
  remote: RemotePreset;
  syncedAt: string | null;
  blocker: Warning | null;
};

export function buildPresets(ctx: Ctx, remote: ReadonlyMap<string, RemotePreset>): PresetView[] {
  const { snapshot, settings, q } = ctx;
  const days = q.days ?? settings.scenarios.days;
  const current = currentBans(snapshot);
  const desired = desiredBans(ctx.bans);
  const slugs = trackedSlugs(snapshot.models, settings, ctx.presets);
  return snapshot.models
    .filter(hasPreset)
    .map((input) => {
      const preset = ctx.presets.get(input.slug);
      const basis = presetBasis(ctx, input.slug);
      const calc = calcModel(input, ctx, basis, current, desired);
      const { model, profile, ranked, scores, pool } = calc;
      const excludedTags = new Set(preset?.excluded ?? []);
      const eligible = pool.filter((e) => !excludedTags.has(e.tag));
      const slug = slugs.get(model.slug)!;
      const config = presetConfig(model, ranked, profile, settings);
      const hash = configHash(config);
      const money = costs(model, ranked, current, desired, profile, days, settings);
      const r = remote.has(slug) ? remote.get(slug)! : undefined;
      const status: PresetView["status"] =
        ranked.length === 0
          ? "empty"
          : r === undefined
            ? "unknown"
            : r === null
              ? "not-created"
              : remoteMatches(r, preset?.syncedHash, hash)
                ? "up-to-date"
                : remoteForeign(r, model.slug, preset?.syncedAt)
                  ? "foreign"
                  : "out-of-date";
      const cheapestEp = eligible.reduce<ClassifiedEndpoint | null>((best, e) => (!best || unitCost(e, profile.h, profile.r) < unitCost(best, profile.h, profile.r) ? e : best), null);
      const cheapestCost = cheapestEp ? unitCost(cheapestEp, profile.h, profile.r) : null;
      const pinned = new Set(preset?.pinned ?? []);
      const mode = settings.optimizer.routingPrice;
      const toMoney = (perM: number | null, perDay: number) => (perM === null ? null : (perM * perDay * days) / 1_000_000);
      const scenarios: PresetScenario[] = [
        { name: DEFAULT_SCENARIO, tools: false },
        ...settings.scenarios.profiles.map((p) => ({ name: p.name, tools: p.tools })),
      ].map((sc) => {
        const p = resolveProfile(input, settings, { scenario: sc.name, tokensPerDay: profile.inputPerDay });
        return {
          name: sc.name,
          h: p.h,
          r: p.r,
          tools: p.tools,
          inputPerDay: p.inputPerDay,
          default: toMoney(pricePerMillion(model, current, p.h, p.r, p.tools, mode).price, p.inputPerDay),
          preset: toMoney(presetPrice(servable(ranked, p.tools), p.h, p.r), p.inputPerDay),
        };
      });
      return {
        model: model.slug,
        name: input.name,
        openWeights: input.openWeights !== false,
        slug,
        presetId: `@preset/${slug}`,
        profile,
        horizonDays: days,
        autoSync: preset?.autoSync ?? false,
        pinned: preset?.pinned ?? [],
        excluded: preset?.excluded ?? [],
        picked: preset?.picked ?? null,
        rankBy: settings.presets.rankBy,
        ranked: ranked.map((e, i) => {
          const costPerM = unitCost(e, profile.h, profile.r);
          return {
            rank: i + 1,
            tag: e.tag,
            provider: e.provider,
            providerName: e.providerName,
            quantization: e.quantization,
            pIn: e.pIn,
            pOut: e.pOut,
            pCache: e.pCache,
            cacheKnown: e.cacheKnown,
            costPerM,
            effectivePerM: effectivePerM(e, profile),
            costHorizon: (costPerM * profile.inputPerDay * days) / 1_000_000,
            vsCheapest: cheapestCost && cheapestCost > 0 ? costPerM / cheapestCost - 1 : null,
            uptime: e.uptime,
            tps: e.tps,
            overall: scores.get(e)!.overall,
            pinned: pinned.has(e.tag),
            picked: preset?.picked?.includes(e.tag) ?? false,
          };
        }),
        cheapest: cheapestEp && cheapestCost !== null ? { tag: cheapestEp.tag, providerName: cheapestEp.providerName, costPerM: cheapestCost } : null,
        eligibleCount: eligible.length,
        policy: {
          quantizations: config.provider.quantizations ?? [],
          minQuantization: model.openWeights !== false ? modelMinQuantization(model.slug, settings) : null,
          zdr: ranked.length > 0 && ranked.every((e) => e.zdr),
          tools: profile.tools,
          fallbacks: true,
        },
        perM: {
          default: pricePerMillion(model, current, profile.h, profile.r, profile.tools, mode).price,
          preset: presetPrice(ranked, profile.h, profile.r),
        },
        cost: {
          default: money.default,
          preset: money.preset,
          saving: money.default !== null && money.preset !== null ? money.preset - money.default : null,
          savingPct: money.default && money.preset !== null ? (money.preset - money.default) / money.default : null,
        },
        estimate: modelEstimate(input, calc, ranked, current, profile, days, modelCalibration(input, calc, ranked, current, ctx)),
        scenarios,
        config,
        hash,
        status,
        remote: r ?? null,
        syncedAt: preset?.syncedAt ?? null,
        blocker: presetBlocker(input, calc, desired, basis.zdrOnly, settings),
      };
    });
}

function costChange(
  models: ClassifiedModel[],
  profiles: ReadonlyMap<string, Profile>,
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
  days: number,
  settings: Settings,
): { before: number; after: number; blocked: boolean } {
  let was = 0;
  let now = 0;
  let blocked = false;
  for (const m of models) {
    const p = profiles.get(m.slug)!;
    const priceOf = (set: ReadonlySet<string>) => pricePerMillion(m, set, p.h, p.r, p.tools, settings.optimizer.routingPrice).price;
    const a = priceOf(before);
    if (a === null) continue;
    const b = priceOf(after);
    if (b === null) {
      blocked = true;
      continue;
    }
    was += (a * p.inputPerDay * days) / 1_000_000;
    now += (b * p.inputPerDay * days) / 1_000_000;
  }
  return { before: was, after: now, blocked };
}

export type ChangeRow = PriceChange & { modelName: string; providerName: string; significant: boolean };
export type ChangesView = { days: number; threshold: number; changes: ChangeRow[] };

export function changeProfiles(snapshot: AppSnapshot, settings: Settings): (model: string) => { h: number; r: number } {
  const q = savedQuery(settings);
  const byModel = new Map(snapshot.models.map((m) => [m.slug, m]));
  return (model) => {
    const input = byModel.get(model);
    return input ? resolveProfile(input, settings, q) : settings.defaultProfile;
  };
}

export function buildChanges(snapshot: AppSnapshot, settings: Settings, events: readonly PriceEvent[]): ChangesView {
  const byModel = new Map(snapshot.models.map((m) => [m.slug, m]));
  const changes = priceChanges(events, changeProfiles(snapshot, settings)).map((c) => {
    const input = byModel.get(c.model);
    return {
      ...c,
      modelName: input?.name ?? c.model,
      providerName: input?.endpoints.find((e) => e.tag === c.tag)?.providerName ?? c.tag.split("/")[0]!,
      significant: isSignificant(c),
    };
  });
  return { days: HISTORY_DAYS, threshold: CHANGE_THRESHOLD, changes };
}

export function spendChange(ctx: Ctx, before: ReadonlySet<string>, after: ReadonlySet<string>): { before: number; after: number; blocked: boolean } {
  const { snapshot, settings, q } = ctx;
  const vs = viewSettings(settings, q);
  const models = snapshot.models.map((input) => classifyModel(input, vs));
  const profiles = new Map(snapshot.models.map((input) => [input.slug, resolveProfile(input, settings, q)]));
  return costChange(models, profiles, before, after, q.days ?? settings.scenarios.days, settings);
}

export type HistoryEntry = RunRecord & { added: string[]; removed: string[]; source: "manual" | "auto" | "rollback" };

export function historyEntries(runs: RunRecord[]): HistoryEntry[] {
  return runs.map((r) => ({
    ...r,
    added: r.ignoredAfter.filter((p) => !r.ignoredBefore.includes(p)),
    removed: r.ignoredBefore.filter((p) => !r.ignoredAfter.includes(p)),
    source: r.kind === "rollback" ? "rollback" : r.kind === "apply" ? "manual" : "auto",
  }));
}
