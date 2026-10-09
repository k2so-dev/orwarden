import { sendAlert } from "../core/alert.ts";
import { classifyAll } from "../core/classify.ts";
import { collect } from "../core/collect.ts";
import { HttpError, type OpenRouterApi } from "../core/openrouter.ts";
import { changeLine, isSignificant, priceChanges } from "../core/changes.ts";
import { changeProfiles, resolveQuery, type AppSnapshot } from "./analysis.ts";
import { sorted } from "./bans.ts";
import { syncPresets, type SyncResult } from "./presets.ts";
import type { Runtime } from "./state.ts";

export type RefreshResult = {
  takenAt: string;
  models: number;
  skipped: string[];
  presets: SyncResult[];
  prices: string[];
};

export async function takeSnapshot(client: OpenRouterApi, rt: Runtime): Promise<AppSnapshot> {
  const settings = rt.settings();
  const now = rt.now();
  const key = await client.getKey();
  const workspaces = await client.listWorkspaces();
  const ws =
    workspaces.find((w) => w.id === settings.workspaceId) ??
    workspaces.find((w) => w.id === key.workspace_id) ??
    (workspaces.length === 1 ? workspaces[0] : undefined);
  if (!ws?.default_guardrail_id) throw new Error(`workspace ${key.workspace_id ?? "(unknown)"} has no default guardrail`);
  const guardrail = await client.getGuardrail(ws.default_guardrail_id);
  const listed = await client.listModels();
  const openWeights = new Set(listed.filter((m) => Boolean(m.hugging_face_id)).map((m) => m.id));
  const snapshot = await collect(client, settings, guardrail, now, openWeights);
  const catalog = listed.map((m) => ({ id: m.id, name: m.name })).sort((a, b) => a.id.localeCompare(b.id));
  return {
    takenAt: snapshot.takenAt,
    workspace: { id: ws.id, name: ws.name ?? ws.id, guardrailId: ws.default_guardrail_id },
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name ?? w.id })),
    key: { label: key.label ?? null, expiresAt: key.expires_at ?? null },
    guardrail,
    models: snapshot.models,
    skipped: snapshot.skipped,
    catalog,
  };
}

const MAX_PRICE_LINES = 10;

function alertText(snapshot: AppSnapshot, presets: SyncResult[], prices: string[] = []): string | null {
  const lines: string[] = [];
  if (prices.length > 0) {
    lines.push("Price changes:", ...prices.slice(0, MAX_PRICE_LINES).map((l) => `  ${l}`));
    if (prices.length > MAX_PRICE_LINES) lines.push(`  and ${prices.length - MAX_PRICE_LINES} more`);
  }
  const failed = presets.filter((p) => p.status === "failed");
  const synced = presets.filter((p) => p.status === "synced");
  if (synced.length > 0) lines.push(`Presets synced: ${synced.map((p) => p.slug).join(", ")}`);
  if (failed.length > 0) lines.push(`Preset sync failed: ${failed.map((p) => `${p.slug} (${p.error})`).join(", ")}`);
  if (snapshot.key.expiresAt && Date.parse(snapshot.key.expiresAt) - Date.parse(snapshot.takenAt) < 2 * 86_400_000) {
    lines.push(`Management key expires ${snapshot.key.expiresAt}`);
  }
  return lines.length > 0 ? ["orwarden", ...lines].join("\n") : null;
}

export async function refresh(rt: Runtime, scheduled = false): Promise<RefreshResult> {
  const settings = rt.settings();
  const startedAt = rt.now().toISOString();
  const alert = (text: string) => sendAlert(settings.alerts, text).catch((err) => console.error(`alert failed: ${err}`));
  try {
    const client = await rt.client();
    const snapshot = await takeSnapshot(client, rt);
    rt.setSnapshot(snapshot);
    const classified = classifyAll(snapshot.models, settings);
    rt.store.addHistory(
      snapshot.takenAt,
      snapshot.models.flatMap((m, i) =>
        m.endpoints.map((e, j) => ({ model: m.slug, tag: e.tag, pIn: e.pIn, pOut: e.pOut, pCache: e.pCache, uptime: e.uptime, tps: e.tps, verdict: classified[i]?.endpoints[j]?.cls ?? null })),
      ),
    );
    rt.store.recordPrices(snapshot.takenAt, snapshot.models);
    rt.invalidateHistory();
    const priceLines = priceChanges(rt.store.priceEvents(""), changeProfiles(snapshot, settings, rt.store.presetSettings()))
      .filter((c) => c.ts === snapshot.takenAt && isSignificant(c))
      .map(changeLine);
    if (!rt.store.getValue<boolean>("policies_imported")) {
      const current = sorted((snapshot.guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
      rt.store.replaceBanPolicies(current, startedAt);
      rt.store.setValue("policies_imported", true);
    }

    let presets: SyncResult[] = [];
    if (scheduled) {
      presets = await syncPresets(rt, "auto", resolveQuery(settings), settings.mode === "dry-run");
    }
    const current = sorted((snapshot.guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
    rt.store.saveRun({
      startedAt,
      kind: scheduled ? "scheduled" : "refresh",
      mode: settings.mode,
      status: "ok",
      ignoredBefore: current,
      ignoredAfter: current,
      patched: false,
      error: null,
    });
    rt.lastError = null;
    const text = scheduled ? alertText(snapshot, presets, priceLines) : priceLines.length > 0 ? alertText(snapshot, [], priceLines) : null;
    if (text) await alert(text);
    return { takenAt: snapshot.takenAt, models: snapshot.models.length, skipped: snapshot.skipped, presets, prices: priceLines };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rt.lastError = { at: startedAt, message, status: err instanceof HttpError ? err.status : null };
    rt.store.saveRun({
      startedAt,
      kind: scheduled ? "scheduled" : "refresh",
      mode: settings.mode,
      status: "failed",
      ignoredBefore: [],
      ignoredAfter: [],
      patched: false,
      error: message,
    });
    if (scheduled) await alert(`orwarden refresh failed: ${message}`);
    throw err;
  }
}
