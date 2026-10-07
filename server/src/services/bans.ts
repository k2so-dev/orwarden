import { classifyAll } from "../core/classify.ts";
import { autoSet, type ProviderState } from "../core/hysteresis.ts";
import { preflight, type Reverted } from "../core/preflight.ts";
import type { Violation } from "../core/optimizer.ts";
import type { Decision, RunKind } from "../db.ts";
import { allowedProviders, desiredBans, fixedBans, historyEntries, type HistoryEntry } from "./analysis.ts";
import { AppError, type Runtime } from "./state.ts";

export const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
export const sameSet = (a: string[], b: string[]) => {
  const x = sorted(a);
  const y = sorted(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export type ApplyResult = {
  runId: number | null;
  dryRun: boolean;
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
  patched: boolean;
  reverted: Reverted[];
  unresolved: Violation[];
};

export async function resolveGuardrailId(rt: Runtime): Promise<string> {
  const snap = rt.snapshot();
  if (snap) return snap.workspace.guardrailId;
  const client = await rt.client();
  const key = await client.getKey();
  const workspaces = await client.listWorkspaces();
  const ws = workspaces.find((w) => w.id === key.workspace_id) ?? (workspaces.length === 1 ? workspaces[0] : undefined);
  if (!ws?.default_guardrail_id) throw new AppError(502, "no-guardrail", "Workspace default guardrail not found");
  return ws.default_guardrail_id;
}

export function releaseAuto(states: Map<string, ProviderState>, providers: Iterable<string>): void {
  for (const p of providers) {
    const s = states.get(p);
    if (s) s.autoBanned = false;
    if (s && s.banStreak === 0 && s.cleanStreak === 0) states.delete(p);
  }
}

export async function applyBans(
  rt: Runtime,
  opts: { kind?: RunKind; force?: boolean; dryRun?: boolean; decisions?: Decision[] } = {},
): Promise<ApplyResult> {
  const settings = rt.settings();
  const snapshot = rt.requireSnapshot();
  const client = await rt.client();
  const startedAt = rt.now().toISOString();
  const policies = rt.store.policies();
  const states = rt.store.loadStates();
  const fixed = fixedBans({ policies, states });
  const allowed = allowedProviders({ policies, states });
  const models = classifyAll(snapshot.models, settings);
  const auto = new Set([...autoSet(states)].filter((p) => !allowed.has(p) && !fixed.has(p)));
  const pre = preflight(models, fixed, auto, [], settings.optimizer.minEndpointsPerModel);
  if (pre.unresolved.length > 0 && !opts.force) {
    throw new AppError(422, "would-break-models", "Bans would leave models without enough providers", pre.unresolved);
  }
  if (pre.reverted.length > 0 && !opts.dryRun) {
    releaseAuto(states, pre.reverted.map((r) => r.provider));
    rt.store.saveStates(states);
  }

  const guardrailId = snapshot.workspace.guardrailId;
  const guardrail = await client.getGuardrail(guardrailId);
  const before = sorted((guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
  const after = sorted([...fixed, ...pre.auto]);
  let patched = false;
  if (opts.dryRun) {
    return {
      runId: null,
      dryRun: true,
      before,
      after,
      added: after.filter((p) => !before.includes(p)),
      removed: before.filter((p) => !after.includes(p)),
      patched: false,
      reverted: pre.reverted,
      unresolved: pre.unresolved,
    };
  }
  if (!sameSet(before, after)) {
    const updated = await client.patchGuardrail(guardrailId, { ignored_providers: after });
    rt.setSnapshot({ ...snapshot, guardrail: updated });
    patched = true;
  }
  const decisions: Decision[] = [
    ...(opts.decisions ?? []),
    ...pre.reverted.map((r) => ({
      provider: r.provider,
      action: "preflight-revert",
      reason: `${r.slug} would keep ${r.admissible}/${r.required} good endpoints`,
      delta: null,
    })),
  ];
  const runId = rt.store.saveRun(
    {
      startedAt,
      kind: opts.kind ?? "apply",
      mode: settings.mode,
      status: "ok",
      ignoredBefore: before,
      ignoredAfter: after,
      patched,
      error: null,
    },
    decisions,
  );
  return {
    runId,
    dryRun: false,
    before,
    after,
    added: after.filter((p) => !before.includes(p)),
    removed: before.filter((p) => !after.includes(p)),
    patched,
    reverted: pre.reverted,
    unresolved: pre.unresolved,
  };
}

export type RollbackResult = { runId: number; sourceRunId: number; from: string[]; to: string[]; patched: boolean };

export async function rollback(rt: Runtime, runId?: number): Promise<RollbackResult> {
  const source = runId !== undefined ? rt.store.getRun(runId) : rt.store.recentRuns(1, true)[0];
  if (!source) throw new AppError(404, "run-not-found", runId !== undefined ? `Run ${runId} not found` : "Nothing to roll back");
  if (source.status !== "ok") throw new AppError(422, "run-failed", `Run ${source.id} failed and has no state`);
  const to = sorted(runId !== undefined ? source.ignoredAfter : source.ignoredBefore);
  const client = await rt.client();
  const guardrailId = await resolveGuardrailId(rt);
  const guardrail = await client.getGuardrail(guardrailId);
  const from = sorted((guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
  const now = rt.now().toISOString();

  const states = rt.store.loadStates();
  const keepAuto = new Set([...autoSet(states)].filter((p) => to.includes(p)));
  releaseAuto(states, [...autoSet(states)].filter((p) => !keepAuto.has(p)));
  rt.store.saveStates(states);
  rt.store.replaceBanPolicies(to.filter((p) => !keepAuto.has(p)), now);
  for (const [p, policy] of rt.store.policies()) if (policy === "allow" && to.includes(p)) rt.store.setPolicy(p, null, now);

  let patched = false;
  if (!sameSet(from, to)) {
    const updated = await client.patchGuardrail(guardrailId, { ignored_providers: to });
    const snap = rt.snapshot();
    if (snap) rt.setSnapshot({ ...snap, guardrail: updated });
    patched = true;
  }
  const reason = `rollback to run ${source.id}`;
  const id = rt.store.saveRun(
    { startedAt: now, kind: "rollback", mode: rt.settings().mode, status: "ok", ignoredBefore: from, ignoredAfter: to, patched, error: null },
    [
      ...to.filter((p) => !from.includes(p)).map((p) => ({ provider: p, action: "ban", reason, delta: null })),
      ...from.filter((p) => !to.includes(p)).map((p) => ({ provider: p, action: "unban", reason, delta: null })),
    ],
  );
  return { runId: id, sourceRunId: source.id, from, to, patched };
}

export function banHistory(rt: Runtime, limit = 50): (HistoryEntry & { decisions: Decision[] })[] {
  return historyEntries(rt.store.recentRuns(limit)).map((r) => ({ ...r, decisions: rt.store.decisionsFor(r.id) }));
}

export function pendingDiff(rt: Runtime): { current: string[]; desired: string[] } {
  const snap = rt.requireSnapshot();
  return {
    current: sorted((snap.guardrail.ignored_providers ?? []).map((p) => p.toLowerCase())),
    desired: sorted(desiredBans(rt.banInputs())),
  };
}

export function discardDrafts(rt: Runtime): { policies: number } {
  const snap = rt.requireSnapshot();
  const current = sorted((snap.guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
  const states = rt.store.loadStates();
  releaseAuto(states, [...autoSet(states)].filter((p) => !current.includes(p)));
  rt.store.saveStates(states);
  const now = rt.now().toISOString();
  rt.store.replaceBanPolicies(current.filter((p) => !autoSet(states).has(p)), now);
  return { policies: current.length };
}
