import { useStorage } from "@vueuse/core";
import { computed } from "vue";
import type { ViewQuery } from "@/lib/api";

export const DAY_OPTIONS = [
  { value: "1", label: "1d" },
  { value: "7", label: "7d" },
  { value: "30", label: "30d" },
];

export const QUANT_OPTIONS = [
  { value: "fp4", label: "fp4+" },
  { value: "fp8", label: "fp8+" },
  { value: "bf16", label: "bf16+" },
];

export const DEFAULT_WEIGHTS = { price: 60, speed: 20, reliability: 20 };

export const KINDS = {
  agent: { label: "Agent", hint: "High cache reuse, short outputs — tool loops and coding agents" },
  rag: { label: "RAG / long context", hint: "Large reused context, moderate answers" },
  chat: { label: "Chat", hint: "Little cache, balanced replies" },
  reason: { label: "Reasoning", hint: "Output-heavy — long thinking and answers" },
  extract: { label: "Extraction", hint: "Short structured outputs from large inputs" },
} as const;

export type Kind = keyof typeof KINDS;

export function kindOf(cache: number, ratio: number): Kind {
  if (ratio >= 0.8) return "reason";
  if (cache >= 0.6 && ratio <= 0.2) return "agent";
  if (cache >= 0.35 && ratio <= 0.5) return "rag";
  if (ratio <= 0.1) return "extract";
  return "chat";
}

export const localView = useStorage("rr-view", { days: 7, hideBanned: false }, localStorage, { mergeDefaults: true });

export const viewQuery = computed<ViewQuery>(() => ({
  days: String(localView.value.days),
  hideBanned: String(localView.value.hideBanned),
}) as unknown as ViewQuery);
