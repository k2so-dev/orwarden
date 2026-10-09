import type { Hold } from "../db.ts";
import type { AnalyticsRow } from "./openrouter.ts";
import type { Endpoint } from "./types.ts";

export const WARM_MINUTES = 15;

export type UsageRow = { ts: string; model: string; provider: string; requests: number; usd: number };
export type HoldUsage = { recent: UsageRow[]; hourly: UsageRow[] };
export type ReleaseReason = "cold" | "expired" | "budget" | "ineligible";
export type HoldDecision = { holds: Hold[]; released: { tag: string; reason: ReleaseReason }[] };

export type HoldInput = {
  model: string;
  previous: readonly string[];
  base: readonly string[];
  pool: readonly Endpoint[];
  holds: readonly Hold[];
  usage: HoldUsage | null;
  now: Date;
  maxHours: number;
  maxUsd: number;
  overpayRate: (e: Endpoint) => number;
};

const num = (v: string | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v) || 0);

export function usageRows(rows: readonly AnalyticsRow[], granularity: "minute" | "hour"): UsageRow[] {
  return rows.map((r) => ({
    ts: `${String(r[`created_at__${granularity}`] ?? "").replace(" ", "T")}Z`,
    model: String(r.model ?? ""),
    provider: String(r.provider ?? ""),
    requests: num(r.request_count),
    usd: num(r.total_usage),
  }));
}

export function matchesModel(name: string, slug: string): boolean {
  return name === slug || (name.startsWith(`${slug}-`) && /^\d{4,8}$/.test(name.slice(slug.length + 1)));
}

const providerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function matchesEndpoint(row: Pick<UsageRow, "model" | "provider">, model: string, e: Pick<Endpoint, "provider" | "providerName">): boolean {
  if (!matchesModel(row.model, model)) return false;
  const key = providerKey(row.provider);
  return key === providerKey(e.providerName) || key === providerKey(e.provider);
}

export function holdCandidates(previous: readonly string[], base: readonly string[], holds: readonly Hold[]): string[] {
  const kept = new Set(base);
  return [...new Set([...previous, ...holds.map((h) => h.tag)])].filter((t) => !kept.has(t));
}

const floorHour = (ts: string) => new Date(Math.floor(Date.parse(ts) / 3_600_000) * 3_600_000).toISOString();

export function decideHolds(input: HoldInput): HoldDecision {
  const { model, usage, now } = input;
  const at = now.toISOString();
  const warmSince = new Date(now.getTime() - WARM_MINUTES * 60_000).toISOString();
  const holds: Hold[] = [];
  const released: HoldDecision["released"] = [];
  for (const tag of holdCandidates(input.previous, input.base, input.holds)) {
    const e = input.pool.find((x) => x.tag === tag);
    if (!e) {
      released.push({ tag, reason: "ineligible" });
      continue;
    }
    const existing = input.holds.find((h) => h.tag === tag);
    const since = existing?.since ?? at;
    const rows = (list: readonly UsageRow[]) => list.filter((r) => matchesEndpoint(r, model, e));
    const warm = usage === null || rows(usage.recent).some((r) => r.requests > 0 && r.ts >= warmSince);
    const spent = !existing ? 0 : usage === null ? null : rows(usage.hourly).filter((r) => r.ts >= floorHour(since)).reduce((a, r) => a + r.usd, 0);
    const overpayUsd = spent === null ? (existing?.overpayUsd ?? 0) : spent * Math.max(0, input.overpayRate(e));
    const reason: ReleaseReason | null = !warm
      ? "cold"
      : now.getTime() - Date.parse(since) > input.maxHours * 3_600_000
        ? "expired"
        : overpayUsd > input.maxUsd
          ? "budget"
          : null;
    if (reason) released.push({ tag, reason });
    else holds.push({ model, tag, since, checkedAt: at, overpayUsd });
  }
  return { holds, released };
}
