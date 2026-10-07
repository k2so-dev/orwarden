import type { Config } from "../settings.ts";
import { baselineOf, objective, type Baseline } from "./cost.ts";
import type { ClassifiedModel } from "./types.ts";

export type Violation = { slug: string; admissible: number; required: number; total: number };

const union = (a: ReadonlySet<string>, b: Iterable<string>) => new Set([...a, ...b]);

export function admissibleCount(model: ClassifiedModel, banned: ReadonlySet<string>): number {
  return model.endpoints.filter((e) => e.cls === "ok" && !banned.has(e.provider)).length;
}

export function totalCount(model: ClassifiedModel, banned: ReadonlySet<string>): number {
  return model.endpoints.filter((e) => !banned.has(e.provider)).length;
}

export function violations(
  models: ClassifiedModel[],
  fixed: ReadonlySet<string>,
  auto: ReadonlySet<string>,
  k: number,
): Violation[] {
  const banned = union(fixed, auto);
  const out: Violation[] = [];
  for (const m of models) {
    const required = Math.min(k, admissibleCount(m, fixed));
    const admissible = admissibleCount(m, banned);
    const total = totalCount(m, banned);
    if (admissible < required || (totalCount(m, fixed) > 0 && total === 0)) {
      out.push({ slug: m.slug, admissible, required, total });
    }
  }
  return out;
}

export function providersOf(models: ClassifiedModel[]): string[] {
  return [...new Set(models.flatMap((m) => m.endpoints.map((e) => e.provider)))].sort();
}

export function lowQuantProviders(models: ClassifiedModel[]): string[] {
  const low = new Set<string>();
  const good = new Set<string>();
  for (const m of models) {
    for (const e of m.endpoints) {
      if (e.quant === "low") low.add(e.provider);
      else if (e.quant === "ok" || e.quant === "closed") good.add(e.provider);
    }
  }
  return [...low].filter((p) => !good.has(p)).sort();
}

export type Move = { provider: string; action: "ban" | "unban" | "force"; objective: number };

export type OptimizeResult = {
  target: Set<string>;
  baseline: Baseline;
  objectiveFixed: number;
  objectiveTarget: number;
  moves: Move[];
};

export function optimize(
  models: ClassifiedModel[],
  fixed: ReadonlySet<string>,
  config: Config,
  allowed: ReadonlySet<string> = new Set(),
): OptimizeResult {
  const { minImprovement, maxMoves, minEndpointsPerModel } = config.optimizer;
  const baseline = baselineOf(models, fixed);
  const candidates = providersOf(models).filter((p) => !fixed.has(p) && !allowed.has(p));
  const target = new Set<string>();
  const objectiveFixed = objective(models, fixed, baseline);
  const moves: Move[] = [];
  const forced = config.filters.banLowQuantProviders ? lowQuantProviders(models).filter((p) => !fixed.has(p) && !allowed.has(p)) : [];
  for (const p of forced) {
    const trial = new Set([...target, p]);
    if (violations(models, fixed, trial, minEndpointsPerModel).length > 0) continue;
    target.add(p);
    moves.push({ provider: p, action: "force", objective: objective(models, union(fixed, target), baseline) });
  }
  const locked = new Set(target);
  let current = objective(models, union(fixed, target), baseline);

  for (let step = 0; step < maxMoves && current > 0; step++) {
    let best: { provider: string; value: number } | null = null;
    for (const p of candidates) {
      if (locked.has(p)) continue;
      const trial = new Set(target);
      if (trial.has(p)) trial.delete(p);
      else trial.add(p);
      if (violations(models, fixed, trial, minEndpointsPerModel).length > 0) continue;
      const value = objective(models, union(fixed, trial), baseline);
      if (!best || value < best.value) best = { provider: p, value };
    }
    if (!best || current - best.value < minImprovement * current) break;
    const action = target.has(best.provider) ? "unban" : "ban";
    if (action === "ban") target.add(best.provider);
    else target.delete(best.provider);
    current = best.value;
    moves.push({ provider: best.provider, action, objective: best.value });
  }
  return { target, baseline, objectiveFixed, objectiveTarget: current, moves };
}

export function banSaving(
  models: ClassifiedModel[],
  banned: ReadonlySet<string>,
  provider: string,
  baseline: Baseline,
): number {
  const without = new Set(banned);
  without.delete(provider);
  return objective(models, without, baseline) - objective(models, union(without, [provider]), baseline);
}
