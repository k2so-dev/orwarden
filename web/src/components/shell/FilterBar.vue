<script setup lang="ts" vapor>
import { computed, watch } from "vue";
import Segmented from "@/components/app/Segmented.vue";
import Toggle from "@/components/app/Toggle.vue";
import RangeSlider from "@/components/app/RangeSlider.vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ANSWER_TAGS, CONTEXT_TAGS, DAY_OPTIONS, DEFAULT_WEIGHTS, QUANT_OPTIONS, QUICK_WORKLOADS, filters, resetWeights, workloadSummary } from "@/stores/filters";
import { overview, settings } from "@/stores/data";

const MODES = [
  { value: "actual", label: "Actual traffic" },
  { value: "workload", label: "Describe workload" },
];
const workload = computed(() => filters.value.scenario !== "actual");
const profiles = computed(() => settings.value?.scenarios.profiles ?? QUICK_WORKLOADS);
const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function syncScenario(): void {
  const f = filters.value;
  const hit = profiles.value.find((p) => same(p.h, f.cache) && same(p.r, f.ratio) && p.tools === f.tools);
  f.scenario = hit?.name ?? "custom";
}

function setMode(mode: string): void {
  if (mode === "actual") filters.value.scenario = "actual";
  else syncScenario();
}

function quick(q: (typeof QUICK_WORKLOADS)[number]): void {
  const f = filters.value;
  f.cache = q.h;
  f.ratio = q.r;
  f.tools = q.tools;
}

watch(
  () => [filters.value.cache, filters.value.ratio, filters.value.tools],
  () => {
    if (workload.value) syncScenario();
  },
);

const summary = computed(() => workloadSummary(filters.value.cache, filters.value.ratio, filters.value.tools));
const emphasis = computed(() => {
  const f = filters.value;
  const main = f.ratio >= 1 ? "output price matters most" : f.cache >= 0.5 ? "cache price matters most" : "input and output prices both matter";
  return f.tools ? `${main} · providers without tool calls are dropped` : main;
});
const tag = (active: boolean) =>
  cn(
    "inline-flex h-[26px] items-center whitespace-nowrap rounded-full border px-2.5 text-[12.5px] font-medium transition-colors",
    active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground hover:text-foreground",
  );

const days = computed({
  get: () => String(filters.value.days),
  set: (value: string) => {
    filters.value.days = Number(value);
  },
});
const actual = computed(() => filters.value.scenario === "actual");
const label = "text-xs font-medium text-muted-foreground";

function onVolume(e: Event): void {
  const v = Number((e.target as HTMLInputElement).value);
  if (v > 0) filters.value.volumeM = v;
}

const weightsLabel = computed(() => `${filters.value.wPrice} / ${filters.value.wSpeed} / ${filters.value.wReliability}`);

type Ranked = { tag: string; name: string; score: number; rank: number };

function rank(wp: number, ws: number, wr: number): Ranked[] {
  const m = overview.value?.models[0];
  if (!m) return [];
  const total = wp + ws + wr || 1;
  return m.endpoints
    .filter((e) => e.eligible)
    .map((e) => ({ tag: e.tag, name: e.providerName, score: (e.scores.price * wp + e.scores.speed * ws + e.scores.reliability * wr) / total, rank: 0 }))
    .sort((a, b) => b.score - a.score)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

const preview = computed(() => {
  const base = new Map(rank(DEFAULT_WEIGHTS.price, DEFAULT_WEIGHTS.speed, DEFAULT_WEIGHTS.reliability).map((e) => [e.tag, e.rank]));
  const f = filters.value;
  return rank(f.wPrice, f.wSpeed, f.wReliability)
    .slice(0, 5)
    .map((e) => {
      const was = base.get(e.tag);
      const delta = was === undefined ? 0 : was - e.rank;
      return {
        ...e,
        text: was === undefined ? "new" : delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : "–",
        tone: was === undefined || delta > 0 ? "text-ok" : delta < 0 ? "text-bad" : "text-muted-foreground",
      };
    });
});
const previewModel = computed(() => overview.value?.models[0]?.name ?? "");
</script>

<template>
  <div class="sticky top-14 z-20 flex flex-wrap items-center gap-x-[22px] gap-y-2.5 border-b border-border bg-background px-5 py-2.5">
    <div class="flex items-center gap-2">
      <span :class="label">Traffic</span>
      <Segmented :model-value="workload ? 'workload' : 'actual'" :options="MODES" @update:model-value="setMode" />
    </div>
    <div class="flex items-center gap-2">
      <span :class="label">Volume</span>
      <div :class="['flex h-8 items-center rounded-lg border border-border', actual && 'opacity-50']">
        <input
          type="number"
          min="0.1"
          step="0.5"
          :value="filters.volumeM"
          :disabled="actual"
          class="tnum h-[30px] w-[52px] bg-transparent text-right text-[13px] outline-none"
          @change="onVolume"
        />
        <span class="whitespace-nowrap pl-1 pr-2.5 text-xs text-muted-foreground">M in / day</span>
      </div>
      <Segmented v-model="days" :options="DAY_OPTIONS" />
      <span v-if="actual" class="text-xs text-muted-foreground">using real 7-day volume</span>
    </div>
    <div v-if="workload" class="flex basis-full flex-wrap items-center gap-x-5 gap-y-2">
      <div class="flex items-center gap-1.5">
        <span :class="[label, 'mr-0.5']">Context</span>
        <button v-for="t in CONTEXT_TAGS" :key="t.label" type="button" :title="t.hint" :class="tag(same(filters.cache, t.value))" @click="filters.cache = t.value">{{ t.label }}</button>
      </div>
      <div class="flex items-center gap-1.5">
        <span :class="[label, 'mr-0.5']">Answers</span>
        <button v-for="t in ANSWER_TAGS" :key="t.label" type="button" :title="t.hint" :class="tag(same(filters.ratio, t.value))" @click="filters.ratio = t.value">{{ t.label }}</button>
      </div>
      <button type="button" :class="tag(filters.tools)" @click="filters.tools = !filters.tools">
        <svg v-if="filters.tools" class="mr-1 size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"></path></svg>
        Tool calls
      </button>
      <div class="flex items-center gap-1 text-xs text-muted-foreground">
        <span class="mr-0.5">Quick:</span>
        <template v-for="(q, i) in QUICK_WORKLOADS" :key="q.name">
          <span v-if="i > 0">·</span>
          <button type="button" :class="['rounded px-1 hover:text-foreground', filters.scenario === q.name && 'font-semibold text-foreground']" @click="quick(q)">{{ q.label }}</button>
        </template>
        <span>·</span>
        <Popover>
          <PopoverTrigger class="rounded px-1 hover:text-foreground">Fine-tune…</PopoverTrigger>
          <PopoverContent align="start" class="flex w-[300px] flex-col gap-3.5 rounded-[10px] p-3.5">
            <div class="text-[13px] font-semibold">Fine-tune workload</div>
            <div class="flex flex-col gap-2">
              <div class="flex justify-between text-[12.5px]"><span>Input from cache</span><span class="tnum text-muted-foreground">{{ Math.round(filters.cache * 100) }}%</span></div>
              <RangeSlider v-model="filters.cache" :min="0" :max="0.95" :step="0.05" />
            </div>
            <div class="flex flex-col gap-2">
              <div class="flex justify-between text-[12.5px]"><span>Output per input token</span><span class="tnum text-muted-foreground">{{ filters.ratio.toFixed(2) }}</span></div>
              <RangeSlider v-model="filters.ratio" :min="0" :max="2" :step="0.05" />
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div class="text-xs text-muted-foreground"><span class="tnum font-medium text-foreground">{{ summary }}</span> · {{ emphasis }}</div>
    </div>
    <div class="flex flex-wrap items-center gap-4">
      <div class="flex items-center gap-2">
        <span :class="label">Min quant</span>
        <Segmented v-model="filters.minQuant" :options="QUANT_OPTIONS" />
      </div>
      <div class="flex items-center gap-2">
        <Toggle v-model="filters.zdrOnly" label="ZDR only" />
        <span class="text-[12.5px]">ZDR only</span>
      </div>
      <div class="flex items-center gap-2">
        <span :class="label">Min uptime</span>
        <RangeSlider v-model="filters.minUptime" class="w-24" :min="90" :max="100" :step="0.5" />
        <span class="tnum w-10 text-[12.5px]">{{ filters.minUptime }}%</span>
      </div>
      <div class="flex items-center gap-2">
        <Toggle v-model="filters.hideBanned" label="Hide banned" />
        <span class="text-[12.5px]">Hide banned</span>
      </div>
    </div>
    <div class="ml-auto">
      <Popover>
        <PopoverTrigger class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium hover:bg-accent">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M20 7h-9"></path>
              <path d="M14 17H5"></path>
              <circle cx="17" cy="17" r="3"></circle>
              <circle cx="7" cy="7" r="3"></circle>
            </svg>
            Weights
            <span class="tnum text-xs text-muted-foreground">{{ weightsLabel }}</span>
          </PopoverTrigger>
        <PopoverContent align="end" class="flex w-[340px] flex-col gap-3 rounded-[10px] p-3.5">
          <div class="flex items-center justify-between">
            <span class="text-[13px] font-semibold">Efficiency weights</span>
            <button type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="resetWeights">Reset 60 / 20 / 20</button>
          </div>
          <div class="grid grid-cols-[80px_1fr_36px] items-center gap-2.5 text-[12.5px]">
            <span>Price</span>
            <RangeSlider v-model="filters.wPrice" :min="0" :max="100" :step="5" />
            <span class="tnum text-right">{{ filters.wPrice }}</span>
            <span>Speed</span>
            <RangeSlider v-model="filters.wSpeed" :min="0" :max="100" :step="5" />
            <span class="tnum text-right">{{ filters.wSpeed }}</span>
            <span>Reliability</span>
            <RangeSlider v-model="filters.wReliability" :min="0" :max="100" :step="5" />
            <span class="tnum text-right">{{ filters.wReliability }}</span>
          </div>
          <div class="flex flex-col gap-1 border-t border-border pt-2.5">
            <div class="mb-0.5 text-xs text-muted-foreground">Live preview · {{ previewModel }} top 5 (vs default weights)</div>
            <div v-for="p in preview" :key="p.tag" class="tnum grid grid-cols-[18px_1fr_32px_32px] gap-2 text-[12.5px]">
              <span class="text-muted-foreground">{{ p.rank }}</span>
              <span>{{ p.name }}</span>
              <span class="text-right">{{ Math.round(p.score) }}</span>
              <span :class="['text-right', p.tone]">{{ p.text }}</span>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  </div>
</template>
