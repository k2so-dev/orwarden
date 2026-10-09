import type { ClassifiedModel } from "./types.ts";

const union = (a: ReadonlySet<string>, b: ReadonlySet<string>) => new Set([...a, ...b]);

export type Violation = { slug: string; admissible: number; required: number; total: number };

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
