import type { Config, RoutingPrice } from "../settings.ts";
import { routingWeight, unitCost } from "./cost.ts";
import type { ClassifiedModel } from "./types.ts";

export type BanSet = { name: string; banned: ReadonlySet<string> };

export type ForecastProfile = {
  name: string;
  tools: boolean | null;
  h: number | null;
  r: number | null;
  inputPerDay: number | null;
};

export type ForecastCell = { perDay: number | null; endpoints: number };
export type ForecastRow = { slug: string; h: number; r: number; inputPerDay: number; cells: ForecastCell[] };
export type ForecastTable = { profile: ForecastProfile; days: number; sets: string[]; rows: ForecastRow[] };

export function pricePerMillion(
  model: ClassifiedModel,
  banned: ReadonlySet<string>,
  h: number,
  r: number,
  tools: boolean,
  mode: RoutingPrice,
): { price: number | null; endpoints: number } {
  let weights = 0;
  let total = 0;
  let endpoints = 0;
  for (const e of model.endpoints) {
    if (banned.has(e.provider) || (tools && !e.tools)) continue;
    const w = routingWeight(e, h, r, mode);
    weights += w;
    total += w * unitCost(e, h, r);
    endpoints++;
  }
  return { price: weights > 0 ? total / weights : null, endpoints };
}

export function forecast(
  models: ClassifiedModel[],
  sets: BanSet[],
  config: Config,
  days: number,
): ForecastTable[] {
  const multi = models.filter((m) => new Set(m.endpoints.map((e) => e.provider)).size > 1);
  const { inputTokensPerDay, profiles } = config.scenarios;
  const all: ForecastProfile[] = [
    { name: "actual", tools: null, h: null, r: null, inputPerDay: null },
    ...profiles.map((p) => ({ ...p, inputPerDay: inputTokensPerDay })),
  ];
  return all.map((profile) => {
    const rows: ForecastRow[] = [];
    for (const m of multi) {
      const inputPerDay = profile.inputPerDay ?? m.inputTokens / config.usageWindowDays;
      if (inputPerDay <= 0) continue;
      const h = profile.h ?? m.h;
      const r = profile.r ?? m.r;
      const cells = sets.map((s) => {
        const { price, endpoints } = pricePerMillion(m, s.banned, h, r, profile.tools ?? false, config.optimizer.routingPrice);
        return { perDay: price === null ? null : (price * inputPerDay) / 1_000_000, endpoints };
      });
      rows.push({ slug: m.slug, h, r, inputPerDay, cells });
    }
    rows.sort((a, b) => (b.cells[0]?.perDay ?? 0) - (a.cells[0]?.perDay ?? 0) || a.slug.localeCompare(b.slug));
    return { profile, days, sets: sets.map((s) => s.name), rows };
  });
}
