import type { Decision, RunKind } from "../db.ts";
import { desiredBans, historyEntries, type HistoryEntry } from "./analysis.ts";
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

export async function applyBans(rt: Runtime, opts: { kind?: RunKind; dryRun?: boolean } = {}): Promise<ApplyResult> {
  const settings = rt.settings();
  const snapshot = rt.requireSnapshot();
  const client = await rt.client();
  const startedAt = rt.now().toISOString();

  const guardrailId = snapshot.workspace.guardrailId;
  const guardrail = await client.getGuardrail(guardrailId);
  const before = sorted((guardrail.ignored_providers ?? []).map((p) => p.toLowerCase()));
  const after = sorted(desiredBans(rt.banInputs()));
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
    };
  }
  if (!sameSet(before, after)) {
    const updated = await client.patchGuardrail(guardrailId, { ignored_providers: after });
    rt.setSnapshot({ ...snapshot, guardrail: updated });
    patched = true;
  }
  const runId = rt.store.saveRun({
    startedAt,
    kind: opts.kind ?? "apply",
    mode: settings.mode,
    status: "ok",
    ignoredBefore: before,
    ignoredAfter: after,
    patched,
    error: null,
  });
  return {
    runId,
    dryRun: false,
    before,
    after,
    added: after.filter((p) => !before.includes(p)),
    removed: before.filter((p) => !after.includes(p)),
    patched,
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

  rt.store.replaceBanPolicies(to, now);

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
  rt.store.replaceBanPolicies(current, rt.now().toISOString());
  return { policies: current.length };
}
