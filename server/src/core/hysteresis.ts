import type { Config } from "../settings.ts";

export type ProviderState = { provider: string; autoBanned: boolean; banStreak: number; cleanStreak: number };
export type Change = { provider: string; action: "ban" | "unban" };
export type Pending = Change & { streak: number; needed: number; capped: boolean };

export type HysteresisResult = {
  states: Map<string, ProviderState>;
  changes: Change[];
  pending: Pending[];
};

export function applyHysteresis(
  previous: ReadonlyMap<string, ProviderState>,
  target: ReadonlySet<string>,
  priority: (provider: string) => number,
  config: Config,
): HysteresisResult {
  const { banAfterRuns, unbanAfterRuns } = config.optimizer.hysteresis;
  const states = new Map<string, ProviderState>();
  for (const [k, v] of previous) states.set(k, { ...v });
  const names = [...new Set([...states.keys(), ...target])].sort();
  const ready: Change[] = [];
  const pending: Pending[] = [];

  for (const provider of names) {
    const s = states.get(provider) ?? { provider, autoBanned: false, banStreak: 0, cleanStreak: 0 };
    states.set(provider, s);
    const wanted = target.has(provider);
    if (wanted && !s.autoBanned) {
      s.banStreak += 1;
      s.cleanStreak = 0;
      if (s.banStreak >= banAfterRuns) ready.push({ provider, action: "ban" });
      else pending.push({ provider, action: "ban", streak: s.banStreak, needed: banAfterRuns, capped: false });
    } else if (!wanted && s.autoBanned) {
      s.cleanStreak += 1;
      s.banStreak = 0;
      if (s.cleanStreak >= unbanAfterRuns) ready.push({ provider, action: "unban" });
      else pending.push({ provider, action: "unban", streak: s.cleanStreak, needed: unbanAfterRuns, capped: false });
    } else {
      s.banStreak = 0;
      s.cleanStreak = 0;
    }
  }

  ready.sort((a, b) => Math.abs(priority(b.provider)) - Math.abs(priority(a.provider)) || a.provider.localeCompare(b.provider));
  const changes = ready.slice(0, config.optimizer.maxChangesPerRun);
  for (const c of ready.slice(changes.length)) {
    const s = states.get(c.provider)!;
    const ban = c.action === "ban";
    pending.push({ ...c, streak: ban ? s.banStreak : s.cleanStreak, needed: ban ? banAfterRuns : unbanAfterRuns, capped: true });
  }
  for (const c of changes) {
    const s = states.get(c.provider)!;
    s.autoBanned = c.action === "ban";
    s.banStreak = 0;
    s.cleanStreak = 0;
  }
  for (const [k, s] of states) {
    if (!s.autoBanned && s.banStreak === 0 && s.cleanStreak === 0) states.delete(k);
  }
  return { states, changes, pending };
}

export const autoSet = (states: ReadonlyMap<string, ProviderState>) =>
  new Set([...states.values()].filter((s) => s.autoBanned).map((s) => s.provider));
