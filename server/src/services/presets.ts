import { unitCost } from "../core/cost.ts";
import { decideHolds, holdCandidates, usageRows, WARM_MINUTES, type HoldUsage, type ReleaseReason } from "../core/hold.ts";
import type { Hold, PresetSettings } from "../db.ts";
import {
  buildPresets,
  legacySlug,
  presetPools,
  presetPrice,
  presetSlugs,
  remoteConfigHash,
  remoteEdits,
  remoteForeign,
  remoteMatches,
  remoteOnly,
  trackedSlugs,
  type PresetView,
  type RemotePreset,
  type ViewQuery,
} from "./analysis.ts";
import { AppError, type Runtime } from "./state.ts";

const REMOTE_TTL_MS = 60_000;
const remoteCache = new Map<string, { at: number; value: RemotePreset }>();

export function clearRemoteCache(): void {
  remoteCache.clear();
}

export async function remoteStatus(rt: Runtime, slugs: string[], fresh = false): Promise<Map<string, RemotePreset>> {
  const out = new Map<string, RemotePreset>();
  const client = await rt.client().catch(() => null);
  const now = Date.now();
  await Promise.all(
    slugs.map(async (slug) => {
      const hit = remoteCache.get(slug);
      if (hit && !fresh && now - hit.at < REMOTE_TTL_MS) {
        out.set(slug, hit.value);
        return;
      }
      if (!client) return;
      try {
        const p = await client.getPreset(slug);
        const value: RemotePreset = p
          ? {
              hash: remoteConfigHash(p.designated_version?.config),
              model: typeof p.designated_version?.config?.model === "string" ? p.designated_version.config.model : null,
              only: remoteOnly(p.designated_version?.config),
              edits: remoteEdits(p.designated_version),
              version: p.designated_version?.version ?? null,
              updatedAt: p.designated_version?.updated_at ?? p.updated_at ?? null,
            }
          : null;
        remoteCache.set(slug, { at: now, value });
        out.set(slug, value);
      } catch {
        return;
      }
    }),
  );
  return out;
}

export function presetContext(rt: Runtime, q: ViewQuery) {
  return { snapshot: rt.requireSnapshot(), settings: rt.settings(), q, bans: rt.banInputs(), presets: rt.store.presetSettings(), history: rt.historyInputs(), holds: rt.store.holds() };
}

export async function listPresets(rt: Runtime, q: ViewQuery, fresh = false): Promise<PresetView[]> {
  const ctx = presetContext(rt, q);
  const slugs = [...trackedSlugs(ctx.snapshot.models, ctx.settings, ctx.presets).values()];
  const remote = await remoteStatus(rt, slugs, fresh);
  return buildPresets(ctx, remote);
}

export function defaultPresetSettings(model: string): PresetSettings {
  return { model, slug: null, autoSync: false, pinned: [], excluded: [], picked: null, overrides: {}, syncedHash: null, syncedAt: null };
}

export function updatePresetSettings(rt: Runtime, model: string, patch: Partial<Omit<PresetSettings, "model" | "syncedHash" | "syncedAt">>): PresetSettings {
  const current = rt.store.presetSettings().get(model) ?? defaultPresetSettings(model);
  const next = { ...current, ...patch, model };
  if (next.slug !== current.slug) {
    next.syncedHash = null;
    next.syncedAt = null;
  }
  if (next.slug !== null && next.slug !== current.slug) {
    const stored = rt.store.presetSettings();
    const taken = [...stored].map(([m, p]) => [m, p.slug] as const).find(([m, slug]) => m !== model && slug === next.slug);
    if (taken) throw new AppError(409, "slug-taken", `Slug ${next.slug} is already used by ${taken[0]}`);
  }
  rt.store.savePresetSettings(next);
  return next;
}

export type SyncRisk = "unknown" | "foreign" | "edits";

export type SyncResult = {
  model: string;
  slug: string;
  status: "synced" | "planned" | "skipped" | "failed";
  error?: string;
  held?: string[];
  released?: { tag: string; reason: ReleaseReason }[];
};

const HOUR_MS = 3_600_000;

async function holdUsage(rt: Runtime, since: string | null): Promise<HoldUsage | null> {
  try {
    const client = await rt.client();
    const now = rt.now();
    const query = (granularity: "minute" | "hour", start: number) =>
      client.queryAnalytics({
        dimensions: ["model", "provider"],
        granularity,
        metrics: ["request_count", "total_usage"],
        timeRange: { start: new Date(start).toISOString(), end: now.toISOString() },
        limit: 10_000,
      });
    const [recent, hourly] = await Promise.all([
      query("minute", now.getTime() - (WARM_MINUTES + 1) * 60_000),
      since ? query("hour", Math.floor(Date.parse(since) / HOUR_MS) * HOUR_MS) : Promise.resolve([]),
    ]);
    return { recent: usageRows(recent, "minute"), hourly: usageRows(hourly, "hour") };
  } catch {
    return null;
  }
}

type HoldReview = { holds: Map<string, Hold[]>; notes: Map<string, Pick<SyncResult, "held" | "released">> };

async function reviewHolds(rt: Runtime, ctx: ReturnType<typeof presetContext>, views: readonly PresetView[], remote: ReadonlyMap<string, RemotePreset>): Promise<HoldReview> {
  const holds = new Map(ctx.holds);
  const notes: HoldReview["notes"] = new Map();
  const known = views.filter((v) => remote.get(v.slug) !== undefined);
  const pools = presetPools(ctx, known.map((v) => v.model));
  const work = known.flatMap((v) => {
    const pool = pools.get(v.model);
    if (!pool) return [];
    const previous = remote.get(v.slug)?.only ?? [];
    const current = ctx.holds.get(v.model) ?? [];
    return [{ model: v.model, pool, previous, current, candidates: holdCandidates(previous, pool.base.map((e) => e.tag), current) }];
  });
  const needed = work.some((w) => w.candidates.some((t) => w.pool.pool.some((e) => e.tag === t)));
  const oldest = work.flatMap((w) => w.current.map((h) => h.since)).sort()[0] ?? null;
  const usage = needed ? await holdUsage(rt, oldest) : null;
  const { holdHours, holdMaxUsd } = ctx.settings.presets;
  for (const w of work) {
    if (w.candidates.length === 0 && w.current.length === 0) continue;
    const { profile } = w.pool;
    const worst = presetPrice(w.pool.base, profile.h, profile.r);
    const decision = decideHolds({
      model: w.model,
      previous: w.previous,
      base: w.pool.base.map((e) => e.tag),
      pool: w.pool.pool,
      holds: w.current,
      usage,
      now: rt.now(),
      maxHours: holdHours,
      maxUsd: holdMaxUsd,
      overpayRate: (e) => (worst === null ? 0 : 1 - worst / Math.max(unitCost(e, profile.h, profile.r), 1e-12)),
    });
    holds.set(w.model, decision.holds);
    notes.set(w.model, { held: decision.holds.map((h) => h.tag), released: decision.released });
  }
  return { holds, notes };
}

export function pinLegacySlugs(rt: Runtime): void {
  const stored = rt.store.presetSettings();
  const legacy = [...stored.values()].filter((p) => !p.slug && p.syncedAt);
  if (legacy.length === 0) return;
  const slugs = presetSlugs([...stored.keys()], rt.settings(), stored);
  for (const p of legacy) {
    const slug = slugs.get(p.model)!;
    const same = slug === legacySlug(p.model, rt.settings());
    rt.store.savePresetSettings({ ...p, slug, syncedHash: same ? p.syncedHash : null, syncedAt: same ? p.syncedAt : null });
  }
}

export async function syncPresets(
  rt: Runtime,
  models: string[] | "auto",
  q: ViewQuery,
  dryRun = false,
  accept: readonly SyncRisk[] = [],
  expected: Record<string, string> = {},
): Promise<SyncResult[]> {
  const client = await rt.client();
  const base = presetContext(rt, q);
  const stored = rt.store.presetSettings();
  const pick = (list: PresetView[]) => list.filter((v) => (models === "auto" ? stored.get(v.model)?.autoSync : models.includes(v.model)));
  const draft = buildPresets(base, new Map());
  if (models !== "auto") {
    const missing = models.filter((m) => !draft.some((v) => v.model === m));
    if (missing.length > 0) throw new AppError(404, "unknown-model", `No data for ${missing.join(", ")}`);
  }
  const drafted = pick(draft).filter((v) => v.ranked.length > 0);
  const remote = await remoteStatus(rt, drafted.map((v) => v.slug), true);
  const review = await reviewHolds(rt, base, drafted, remote);
  const selected = pick(buildPresets({ ...base, holds: review.holds }, new Map()));
  const results: SyncResult[] = [];
  const markSynced = (v: PresetView, saved: PresetSettings | undefined, at: string | null) => {
    const held = review.holds.get(v.model);
    if (held && review.notes.has(v.model)) rt.store.replaceHolds(v.model, held);
    const cur = rt.store.presetSettings().get(v.model);
    if ((cur?.slug ?? null) !== (saved?.slug ?? null)) return;
    rt.store.savePresetSettings({ ...(cur ?? defaultPresetSettings(v.model)), slug: v.slug, syncedHash: v.hash, syncedAt: at ?? cur?.syncedAt ?? rt.now().toISOString() });
  };
  for (const v of selected) {
    const saved = stored.get(v.model);
    if (v.ranked.length === 0) {
      results.push({ model: v.model, slug: v.slug, status: "skipped", error: "no eligible endpoints" });
      continue;
    }
    if (expected[v.model] !== undefined && expected[v.model] !== v.slug) {
      results.push({ model: v.model, slug: v.slug, status: "failed", error: `slug changed from ${expected[v.model]} to ${v.slug}; review and sync again` });
      continue;
    }
    const live = remote.get(v.slug);
    const accepted = (risk: SyncRisk) => models !== "auto" && accept.includes(risk);
    if (live === undefined && !accepted("unknown")) {
      results.push({ model: v.model, slug: v.slug, status: "failed", error: "remote status unknown" });
      continue;
    }
    const matches = remoteMatches(live, saved?.syncedHash, v.hash);
    if (!matches && remoteForeign(live, v.model, saved?.syncedAt) && !accepted("foreign")) {
      results.push({
        model: v.model,
        slug: v.slug,
        status: "failed",
        error: live?.model && live.model !== v.model ? `slug is used by a preset for ${live.model}` : "a different preset for this model already exists and was not synced from here",
      });
      continue;
    }
    if (live && live.edits.length > 0 && (models === "auto" ? !matches : !accepted("edits"))) {
      results.push({ model: v.model, slug: v.slug, status: "failed", error: `edited on OpenRouter (${live.edits.join(", ")}); confirm to replace` });
      continue;
    }
    const note = review.notes.get(v.model) ?? {};
    if (models === "auto" && matches) {
      if (!dryRun && (saved?.syncedHash !== v.hash || review.notes.has(v.model))) markSynced(v, saved, null);
      results.push({ model: v.model, slug: v.slug, status: "skipped", ...note });
      continue;
    }
    if (dryRun) {
      results.push({ model: v.model, slug: v.slug, status: "planned", ...note });
      continue;
    }
    try {
      await client.upsertPreset(v.slug, v.config);
      remoteCache.delete(v.slug);
      markSynced(v, saved, rt.now().toISOString());
      results.push({ model: v.model, slug: v.slug, status: "synced", ...note });
    } catch (err) {
      results.push({ model: v.model, slug: v.slug, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
