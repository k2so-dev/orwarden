import type { BadgeKind } from "@/components/app/StatusBadge.vue";
import type { EndpointView } from "@/lib/api";

export type Tone = "fg" | "muted" | "ok" | "warn" | "bad";
export type TipLine = { text: string; tone: Tone };

export function shortIssue(text: string): string {
  return text.replace(" (no cache price)", "").replace(/ quant$/, "").replace(/ median$/, "").replace(/(\d)x\b/, "$1×");
}

export function verdictBadge(e: Pick<EndpointView, "verdict" | "issues">): { kind: BadgeKind; text: string } {
  if (e.verdict === "ok") return { kind: "ok", text: "ok" };
  const level = e.verdict === "outlier" ? "warn" : "bad";
  const issue = e.issues.find((i) => i.level === level) ?? e.issues[0];
  return { kind: level, text: `${e.verdict}: ${issue ? shortIssue(issue.text) : ""}` };
}

export const TONE_CLASS: Record<Tone, string> = {
  fg: "text-foreground",
  muted: "text-muted-foreground",
  ok: "text-ok",
  warn: "text-warn",
  bad: "text-bad",
};
