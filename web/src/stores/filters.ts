import { useStorage } from "@vueuse/core";
import { computed } from "vue";
import type { ViewQuery } from "@/lib/api";

export const SCENARIOS = [
  { value: "actual", label: "Actual traffic" },
  { value: "chat", label: "Chat" },
  { value: "chat-cached", label: "Chat + cache" },
  { value: "agent", label: "Agent + tools" },
  { value: "reasoning", label: "Reasoning" },
  { value: "custom", label: "Custom…" },
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
  cache: 0.5,
  ratio: 0.2,
  tools: false,
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

export function resetWeights(): void {
  filters.value.wPrice = DEFAULT_WEIGHTS.price;
  filters.value.wSpeed = DEFAULT_WEIGHTS.speed;
  filters.value.wReliability = DEFAULT_WEIGHTS.reliability;
}
