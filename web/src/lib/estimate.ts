import type { BadgeKind } from "@/components/app/StatusBadge.vue";
import type { ModelView } from "@/lib/api";
import type { TipLine } from "@/lib/issues";

export type Estimate = NonNullable<ModelView["estimate"]>;
export type Risk = Estimate["risks"][number];

const LEVEL_ORDER: Record<Risk["level"], number> = { bad: 0, warn: 1, info: 2 };
const LEVEL_TONE: Record<Risk["level"], TipLine["tone"]> = { bad: "bad", warn: "warn", info: "muted" };

export const CONFIDENCE: Record<Estimate["confidence"], { kind: BadgeKind; text: string }> = {
  high: { kind: "ok", text: "high confidence" },
  medium: { kind: "warn", text: "medium confidence" },
  low: { kind: "bad", text: "low confidence" },
};

export function sortRisks<T extends Risk>(risks: readonly T[]): T[] {
  return [...risks].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || (b.impactUsd ?? 0) - (a.impactUsd ?? 0));
}

export function riskLines(risks: readonly Risk[], prefix: (r: Risk) => string = () => ""): TipLine[] {
  if (risks.length === 0) return [{ text: "No known risks: prices and uptime were steady and the workload is stable.", tone: "muted" }];
  return sortRisks(risks).map((r) => ({ text: `${prefix(r)}${r.text}`, tone: LEVEL_TONE[r.level] }));
}
