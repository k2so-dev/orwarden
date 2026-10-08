import { useStorage } from "@vueuse/core";
import { computed } from "vue";
import type { ViewQuery } from "@/lib/api";

export const SCENARIOS = [
  { value: "actual", label: "Actual traffic" },
  { value: "chat", label: "Chat" },
  { value: "chat-cached", label: "Chat + cache" },
  { value: "agent", label: "Agent + tools" },
  { value: "reasoning", label: "Reasoning" },
  { value: "custom", label: "Custom workload" },
];

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

export const filters = useStorage("rr-filters", {
  scenario: "actual",
  cache: 0.6,
  ratio: 0.3,
  tools: true,
  volumeM: 1,
  days: 7,
  minQuant: "fp8",
  zdrOnly: false,
  minUptime: 97,
  hideBanned: false,
  wPrice: DEFAULT_WEIGHTS.price,
  wSpeed: DEFAULT_WEIGHTS.speed,
  wReliability: DEFAULT_WEIGHTS.reliability,
}, localStorage, { mergeDefaults: true });

export const viewQuery = computed<ViewQuery>(() => {
  const f = filters.value;
  const q: Record<string, string> = {
    scenario: f.scenario,
    days: String(f.days),
    minQuantization: f.minQuant,
    minUptime: String(f.minUptime / 100),
    zdrOnly: String(f.zdrOnly),
    hideBanned: String(f.hideBanned),
    wPrice: String(f.wPrice),
    wSpeed: String(f.wSpeed),
    wReliability: String(f.wReliability),
  };
  if (f.scenario !== "actual") q.tokensPerDay = String(Math.round(f.volumeM * 1_000_000));
  if (f.scenario === "custom") {
    q.h = String(f.cache);
    q.r = String(f.ratio);
    q.tools = String(f.tools);
  }
  return q as unknown as ViewQuery;
});

export function setWeights(w: { price: number; speed: number; reliability: number }): void {
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  filters.value.wPrice = clamp(w.price);
  filters.value.wSpeed = clamp(w.speed);
  filters.value.wReliability = clamp(w.reliability);
}

export const CONTEXT_TAGS = [
  { value: 0, label: "Fresh", hint: "no cache" },
  { value: 0.5, label: "Partly repeated", hint: "50% cached" },
  { value: 0.8, label: "Mostly repeated", hint: "80% cached" },
];

export const ANSWER_TAGS = [
  { value: 0.05, label: "Short", hint: "out/in 0.05" },
  { value: 0.3, label: "Normal", hint: "out/in 0.3" },
  { value: 1, label: "Long / reasoning", hint: "out/in 1.0" },
];

export const QUICK_WORKLOADS = [
  { name: "chat", label: "Chat", h: 0, r: 0.3, tools: false },
  { name: "chat-cached", label: "Chat + cache", h: 0.5, r: 0.3, tools: false },
  { name: "agent", label: "Agent", h: 0.8, r: 0.05, tools: true },
  { name: "reasoning", label: "Reasoning", h: 0, r: 1, tools: false },
];

export function workloadSummary(h: number, r: number, tools: boolean): string {
  return `cache ${Math.round(h * 100)}% · out/in ${Number(r.toFixed(2))}${tools ? " · tools" : ""}`;
}

export function scenarioLabel(name: string): string {
  if (name === "custom") {
    const f = filters.value;
    return `Custom: ${workloadSummary(f.cache, f.ratio, f.tools)}`;
  }
  return SCENARIOS.find((s) => s.value === name)?.label ?? name;
}
