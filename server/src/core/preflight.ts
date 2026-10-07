import type { Change } from "./hysteresis.ts";
import { violations, type Violation } from "./optimizer.ts";
import type { ClassifiedModel } from "./types.ts";

export type Reverted = { provider: string; slug: string; admissible: number; required: number };

export type PreflightResult = { auto: Set<string>; reverted: Reverted[]; unresolved: Violation[] };

export function preflight(
  models: ClassifiedModel[],
  fixed: ReadonlySet<string>,
  auto: ReadonlySet<string>,
  changes: Change[],
  k: number,
): PreflightResult {
  const next = new Set(auto);
  const reverted: Reverted[] = [];
  const fresh = changes.filter((c) => c.action === "ban").map((c) => c.provider);

  for (;;) {
    const v = violations(models, fixed, next, k)[0];
    if (!v) return { auto: next, reverted, unresolved: [] };
    const model = models.find((m) => m.slug === v.slug)!;
    const onModel = new Set(model.endpoints.map((e) => e.provider));
    const culprit =
      [...fresh].reverse().find((p) => next.has(p) && onModel.has(p)) ?? [...next].sort().find((p) => onModel.has(p));
    if (!culprit) return { auto: next, reverted, unresolved: violations(models, fixed, next, k) };
    next.delete(culprit);
    reverted.push({ provider: culprit, slug: v.slug, admissible: v.admissible, required: v.required });
  }
}
