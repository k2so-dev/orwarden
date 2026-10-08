import { sendAlert } from "../core/alert.ts";
import { classifyAll } from "../core/classify.ts";
import { collect } from "../core/collect.ts";
import { baselineOf, objective } from "../core/cost.ts";
import { applyHysteresis, autoSet } from "../core/hysteresis.ts";
import { HttpError, type OpenRouterApi } from "../core/openrouter.ts";
import { banSaving, optimize } from "../core/optimizer.ts";
import { preflight } from "../core/preflight.ts";
import type { Decision } from "../db.ts";
import { allowedProviders, fixedBans, type AppSnapshot } from "./analysis.ts";
import { applyBans, releaseAuto, sorted, type ApplyResult } from "./bans.ts";
import { syncPresets, type SyncResult } from "./presets.ts";
import type { Runtime } from "./state.ts";

export type RefreshResult = {
  takenAt: string;
  models: number;
  skipped: string[];
  decisions: Decision[];
  applied: ApplyResult | null;
  presets: SyncResult[];
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

function hysteresisStep(rt: Runtime, snapshot: AppSnapshot): Decision[] {
  const settings = rt.settings();
  const inputs = rt.banInputs();
  const fixed = fixedBans(inputs);
  const allowed = allowedProviders(inputs);
  const models = classifyAll(snapshot.models, settings);
  const opt = optimize(models, fixed, settings, allowed);
  const currentAuto = new Set([...autoSet(inputs.states)].filter((p) => !allowed.has(p)));
  const banned = new Set([...fixed, ...currentAuto]);
  const baseline = baselineOf(models, fixed);
  const cache = new Map<string, number>();
  const priority = (p: string) => {
    if (!cache.has(p)) cache.set(p, banSaving(models, banned, p, baseline));
    return cache.get(p)!;
  };
  const hy = applyHysteresis(inputs.states, opt.target, priority, settings);
  const pre = preflight(models, fixed, autoSet(hy.states), hy.changes, settings.optimizer.minEndpointsPerModel);
  releaseAuto(hy.states, pre.reverted.map((r) => r.provider));
  rt.store.saveStates(hy.states);
  const pct = (p: string) => {
    const base = objective(models, banned, baseline);
    return base > 0 ? priority(p) / base : null;
  };
  const { banAfterRuns, unbanAfterRuns } = settings.optimizer.hysteresis;
  const worst = (p: string) => {
    const eps = models.flatMap((m) => m.endpoints.filter((e) => e.provider === p));
    const bad = eps.find((e) => e.cls === "hard-bad") ?? eps.find((e) => e.cls === "outlier");
    return bad ? `${bad.cls} ${bad.reasons[0] ?? ""}`.trim() : "cost";
  };
  return [
    ...hy.changes
      .filter((c) => !pre.reverted.some((r) => r.provider === c.provider))
      .map((c) => ({
        provider: c.provider,
        action: c.action,
        reason: c.action === "ban" ? `${worst(c.provider)} · ${banAfterRuns} of ${banAfterRuns} runs` : `recovered · ${unbanAfterRuns} of ${unbanAfterRuns} runs`,
        delta: pct(c.provider),
      })),
    ...hy.pending.map((p) => ({
      provider: p.provider,
      action: `pending-${p.action}`,
      reason: p.capped ? "capped by maxChangesPerRun" : `${p.streak}/${p.needed} runs`,
      delta: pct(p.provider),
    })),
  ];
}

function alertText(snapshot: AppSnapshot, applied: ApplyResult | null, decisions: Decision[], presets: SyncResult[]): string | null {
  const lines: string[] = [];
  if (applied?.patched) {
    lines.push(`Guardrail updated: + ${applied.added.join(", ") || "-"} / - ${applied.removed.join(", ") || "-"}`);
  }
  for (const r of applied?.reverted ?? []) lines.push(`Reverted ban ${r.provider}: ${r.slug} would keep ${r.admissible}/${r.required}`);
  for (const v of applied?.unresolved ?? []) lines.push(`${v.slug} has ${v.admissible}/${v.required} good endpoints`);
  if (!applied) {
    const changes = decisions.filter((d) => d.action === "ban" || d.action === "unban");
    if (changes.length > 0) lines.push(`Dry-run: ${changes.map((d) => `${d.action} ${d.provider}`).join(", ")}`);
  }
  const failed = presets.filter((p) => p.status === "failed");
  const synced = presets.filter((p) => p.status === "synced");
  if (synced.length > 0) lines.push(`Presets synced: ${synced.map((p) => p.slug).join(", ")}`);
  if (failed.length > 0) lines.push(`Preset sync failed: ${failed.map((p) => `${p.slug} (${p.error})`).join(", ")}`);
  if (snapshot.key.expiresAt && Date.parse(snapshot.key.expiresAt) - Date.parse(snapshot.takenAt) < 2 * 86_400_000) {
    lines.push(`Management key expires ${snapshot.key.expiresAt}`);
  }
  return lines.length > 0 ? ["rerouter", ...lines].join("\n") : null;
}

export async function refresh(rt: Runtime, scheduled = false): Promise<RefreshResult> {
  const settings = rt.settings();
  const startedAt = rt.now().toISOString();
  const alert = (text: string) => sendAlert(settings.alerts, text).catch((err) => console.error(`alert failed: ${err}`));
  try {
    const client = await rt.client();
    const snapshot = await takeSnapshot(client, rt);
    rt.setSnapshot(snapshot);
    rt.store.addHistory(
      snapshot.takenAt,
      snapshot.models.flatMap((m) =>
        m.endpoints.map((e) => ({ model: m.slug, tag: e.tag, pIn: e.pIn, pOut: e.pOut, pCache: e.pCache, uptime: e.uptime, tps: e.tps })),
      ),
    );
    if (!rt.store.getValue<boolean>("policies_imported")) {
      const current = sorted((snapshot.guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
      rt.store.replaceBanPolicies(current, startedAt);
      rt.store.setValue("policies_imported", true);
    }

    let decisions: Decision[] = [];
    let applied: ApplyResult | null = null;
    let presets: SyncResult[] = [];
    if (scheduled) {
      decisions = hysteresisStep(rt, snapshot);
      if (settings.mode === "apply") {
        applied = await applyBans(rt, { kind: "scheduled", force: true, decisions });
      }
      presets = await syncPresets(rt, "auto", { scenario: settings.presets.defaultScenario }, settings.mode === "dry-run");
    }
    if (!applied) {
      const current = sorted((snapshot.guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
      rt.store.saveRun(
        {
          startedAt,
          kind: scheduled ? "scheduled" : "refresh",
          mode: settings.mode,
          status: "ok",
          ignoredBefore: current,
          ignoredAfter: current,
          patched: false,
          error: null,
        },
        decisions,
      );
    }
    rt.lastError = null;
    if (scheduled) {
      const text = alertText(snapshot, applied, decisions, presets);
      if (text) await alert(text);
    }
    return { takenAt: snapshot.takenAt, models: snapshot.models.length, skipped: snapshot.skipped, decisions, applied, presets };
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
    if (scheduled) await alert(`rerouter refresh failed: ${message}`);
    throw err;
  }
}
