import type { PresetSettings } from "../db.ts";
import { buildPresets, remoteConfigHash, type PresetView, type RemotePreset, type ViewQuery } from "./analysis.ts";
import { AppError, type Runtime } from "./state.ts";

const REMOTE_TTL_MS = 5 * 60_000;
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
  return { snapshot: rt.requireSnapshot(), settings: rt.settings(), q, bans: rt.banInputs(), presets: rt.store.presetSettings() };
}

export async function listPresets(rt: Runtime, q: ViewQuery, fresh = false): Promise<PresetView[]> {
  const ctx = presetContext(rt, q);
  const local = buildPresets(ctx, new Map());
  const remote = await remoteStatus(rt, local.map((p) => p.slug), fresh);
  return buildPresets(ctx, remote);
}

export function defaultPresetSettings(model: string): PresetSettings {
  return { model, slug: null, autoSync: false, scenario: null, pinned: [], excluded: [], syncedHash: null, syncedAt: null };
}

export function updatePresetSettings(rt: Runtime, model: string, patch: Partial<Omit<PresetSettings, "model" | "syncedHash" | "syncedAt">>): PresetSettings {
  const current = rt.store.presetSettings().get(model) ?? defaultPresetSettings(model);
  const next = { ...current, ...patch, model };
  if (next.slug !== null) {
    const taken = [...rt.store.presetSettings().values()].find((p) => p.model !== model && p.slug === next.slug);
    if (taken) throw new AppError(409, "slug-taken", `Slug ${next.slug} is already used by ${taken.model}`);
  }
  rt.store.savePresetSettings(next);
  return next;
}

export type SyncResult = { model: string; slug: string; status: "synced" | "planned" | "skipped" | "failed"; error?: string };

export async function syncPresets(rt: Runtime, models: string[] | "auto", q: ViewQuery, dryRun = false): Promise<SyncResult[]> {
  const client = await rt.client();
  const views = buildPresets(presetContext(rt, q), new Map());
  const stored = rt.store.presetSettings();
  const selected = views.filter((v) => (models === "auto" ? stored.get(v.model)?.autoSync : models.includes(v.model)));
  if (models !== "auto") {
    const missing = models.filter((m) => !views.some((v) => v.model === m));
    if (missing.length > 0) throw new AppError(404, "unknown-model", `No data for ${missing.join(", ")}`);
  }
  const results: SyncResult[] = [];
  for (const v of selected) {
    const saved = stored.get(v.model);
    if (v.ranked.length === 0) {
      results.push({ model: v.model, slug: v.slug, status: "skipped", error: "no eligible endpoints" });
      continue;
    }
    if (models === "auto" && saved?.syncedHash === v.hash) {
      results.push({ model: v.model, slug: v.slug, status: "skipped" });
      continue;
    }
    if (dryRun) {
      results.push({ model: v.model, slug: v.slug, status: "planned" });
      continue;
    }
    try {
      await client.upsertPreset(v.slug, v.config);
      remoteCache.delete(v.slug);
      rt.store.savePresetSettings({ ...(saved ?? defaultPresetSettings(v.model)), syncedHash: v.hash, syncedAt: rt.now().toISOString() });
      results.push({ model: v.model, slug: v.slug, status: "synced" });
    } catch (err) {
      results.push({ model: v.model, slug: v.slug, status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}
