<script setup lang="ts" vapor>
import { computed } from "vue";
import RangeSlider from "@/components/app/RangeSlider.vue";
import Segmented from "@/components/app/Segmented.vue";
import Tip from "@/components/app/Tip.vue";
import Toggle from "@/components/app/Toggle.vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { overview, settings } from "@/stores/data";
import { DAY_OPTIONS, DEFAULT_WEIGHTS, KINDS, QUANT_OPTIONS, kindOf, localView } from "@/stores/filters";
import { uptimeFloor, updateView, view } from "@/stores/workload";

const label = "text-xs font-medium text-muted-foreground";
const box = "flex h-9 items-center rounded-[10px] border border-border";

const actualMix = computed(() => {
  const models = (overview.value?.models ?? []).filter((m) => m.profile.inputPerDay > 0);
  const total = models.reduce((a, m) => a + m.profile.inputPerDay, 0);
  if (total === 0) return { cache: view.value.cache, ratio: view.value.ratio };
  return {
    cache: models.reduce((a, m) => a + m.profile.h * m.profile.inputPerDay, 0) / total,
    ratio: models.reduce((a, m) => a + m.profile.r * m.profile.inputPerDay, 0) / total,
  };
});

const shown = computed(() => (view.value.actual ? actualMix.value : { cache: view.value.cache, ratio: view.value.ratio }));
const kind = computed(() => KINDS[kindOf(shown.value.cache, shown.value.ratio)]);
const kindTip = computed(() => [
  { text: kind.value.hint, tone: "fg" as const },
  { text: view.value.actual ? "Each model uses its own cache hit, output/input and volume from the last days of traffic. Drag a slider to describe a workload instead." : "Described by the sliders. Press Actual to use real traffic.", tone: "muted" as const },
]);

const cache = computed({
  get: () => Math.round(shown.value.cache * 100),
  set: (v: number) => updateView({ actual: false, cache: v / 100, ratio: Number(shown.value.ratio.toFixed(2)) }),
});
const ratio = computed({
  get: () => Number(shown.value.ratio.toFixed(2)),
  set: (v: number) => updateView({ actual: false, ratio: v, cache: Math.round(shown.value.cache * 20) / 20 }),
});
const quant = computed({ get: () => view.value.minQuant, set: (v: string) => updateView({ minQuant: v }) });
const uptime = computed({ get: () => view.value.minUptime, set: (v: number) => updateView({ minUptime: v }) });
const tools = computed({ get: () => view.value.tools, set: (v: boolean) => updateView({ tools: v }) });
const zdr = computed({ get: () => view.value.zdrOnly, set: (v: boolean) => updateView({ zdrOnly: v }) });
const hide = computed({ get: () => localView.value.hideBanned, set: (v: boolean) => (localView.value.hideBanned = v) });
const days = computed({ get: () => String(localView.value.days), set: (v: string) => (localView.value.days = Number(v)) });
const filterLabel = computed(() => [`${view.value.minQuant}+`, `≥${view.value.minUptime}%`, ...(view.value.zdrOnly ? ["ZDR"] : []), ...(view.value.tools ? ["tools"] : [])].join(" · "));

const weights = computed(() => view.value.weights);
const weightsLabel = computed(() => `${weights.value.price} / ${weights.value.speed} / ${weights.value.reliability}`);
const setWeight = (key: "price" | "speed" | "reliability", v: number) => updateView({ weights: { ...weights.value, [key]: v } });
const price = computed({ get: () => weights.value.price, set: (v: number) => setWeight("price", v) });
const speed = computed({ get: () => weights.value.speed, set: (v: number) => setWeight("speed", v) });
const reliability = computed({ get: () => weights.value.reliability, set: (v: number) => setWeight("reliability", v) });

function onVolume(e: Event): void {
  const input = e.target as HTMLInputElement;
  const v = Number(input.value);
  if (Number.isFinite(v) && v > 0) updateView({ actual: false, volumeM: v, cache: Math.round(shown.value.cache * 20) / 20, ratio: Number(shown.value.ratio.toFixed(2)) });
  else input.value = String(view.value.volumeM);
}

type Ranked = { tag: string; name: string; score: number; rank: number };

function rank(w: { price: number; speed: number; reliability: number }): Ranked[] {
  const m = overview.value?.models[0];
  if (!m) return [];
  const total = w.price + w.speed + w.reliability || 1;
  return m.endpoints
    .filter((e) => e.eligible)
    .map((e) => ({ tag: e.tag, name: e.providerName, score: (e.scores.price * w.price + e.scores.speed * w.speed + e.scores.reliability * w.reliability) / total, rank: 0 }))
    .sort((a, b) => b.score - a.score)
    .map((e, i) => ({ ...e, rank: i + 1 }));
}

const preview = computed(() => {
  const base = new Map(rank(DEFAULT_WEIGHTS).map((e) => [e.tag, e.rank]));
  return rank(weights.value)
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
const usageDays = computed(() => settings.value?.usageWindowDays ?? 7);
const trigger = "inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium hover:bg-accent";
</script>

<template>
  <div class="sticky top-14 z-20 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border bg-background px-[max(20px,calc((100%-1640px)/2))] py-2">
    <div :class="[box, 'gap-x-3.5 py-1 pl-3 pr-1']">
      <span :class="label">Workload</span>
      <div class="flex items-center gap-2">
        <span class="text-[12.5px]">Cache</span>
        <RangeSlider v-model="cache" class="w-24" :min="0" :max="95" :step="5" />
        <span class="tnum w-[30px] text-[12.5px] font-medium">{{ cache }}%</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-[12.5px]">Out/in</span>
        <RangeSlider v-model="ratio" class="w-24" :min="0" :max="2" :step="0.05" />
        <span class="tnum w-[30px] text-[12.5px] font-medium">{{ ratio.toFixed(2) }}</span>
      </div>
      <Tip :title="`Detected workload: ${kind.label}`" :lines="kindTip" class="inline-flex h-6 items-center rounded-full bg-muted px-2.5 text-xs font-semibold">{{ kind.label }}</Tip>
      <button
        type="button"
        :aria-pressed="view.actual"
        :title="`Use each model's real traffic from the last ${usageDays} days`"
        :class="['h-[26px] rounded-[7px] border px-2.5 text-xs font-medium', view.actual ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent']"
        @click="updateView({ actual: !view.actual })"
      >
        Actual
      </button>
    </div>
    <div :class="[box, 'gap-1 pr-[3px]']">
      <div :class="['flex items-center gap-1', view.actual && 'opacity-50']">
        <input type="number" min="0.1" step="0.5" :value="view.volumeM" :disabled="view.actual" aria-label="Million input tokens per day" class="tnum h-[30px] w-12 bg-transparent text-right text-[13px] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none" @change="onVolume" />
        <span class="whitespace-nowrap text-xs text-muted-foreground">M in/day</span>
      </div>
      <Segmented v-model="days" :options="DAY_OPTIONS" size="sm" />
    </div>
    <div class="ml-auto flex items-center gap-2">
      <Popover>
        <PopoverTrigger :class="trigger">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M22 3H2l8 9.46V19l4 2v-8.54z"></path></svg>
          Filters <span class="tnum text-xs font-normal text-muted-foreground">{{ filterLabel }}</span>
        </PopoverTrigger>
        <PopoverContent align="end" class="flex w-[300px] flex-col gap-3.5 rounded-[10px] p-3.5">
          <div class="text-[13px] font-semibold">Quality filters</div>
          <div class="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-3 text-[12.5px]">
            <span>Min quantization</span><Segmented v-model="quant" :options="QUANT_OPTIONS" size="sm" />
            <span>Min uptime · 1d</span>
            <div class="flex items-center gap-2"><RangeSlider v-model="uptime" class="w-[90px]" :min="uptimeFloor" :max="100" :step="0.5" /><span class="tnum w-[38px] text-right">{{ view.minUptime }}%</span></div>
            <span>Require tool calling</span><Toggle v-model="tools" label="Require tool calling" />
            <span>ZDR only</span><Toggle v-model="zdr" label="ZDR only" />
            <span>Hide banned providers</span><Toggle v-model="hide" label="Hide banned providers" />
          </div>
        </PopoverContent>
      </Popover>
      <Popover>
        <PopoverTrigger :class="trigger">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 7h-9"></path><path d="M14 17H5"></path><circle cx="17" cy="17" r="3"></circle><circle cx="7" cy="7" r="3"></circle></svg>
          Weights <span class="tnum text-xs font-normal text-muted-foreground">{{ weightsLabel }}</span>
        </PopoverTrigger>
        <PopoverContent align="end" class="flex w-[340px] flex-col gap-3 rounded-[10px] p-3.5">
          <div class="flex items-center justify-between">
            <span class="text-[13px] font-semibold">Efficiency weights</span>
            <button type="button" class="text-xs text-muted-foreground hover:text-foreground" @click="updateView({ weights: DEFAULT_WEIGHTS })">Reset {{ DEFAULT_WEIGHTS.price }} / {{ DEFAULT_WEIGHTS.speed }} / {{ DEFAULT_WEIGHTS.reliability }}</button>
          </div>
          <div class="grid grid-cols-[80px_1fr_36px] items-center gap-2.5 text-[12.5px]">
            <span>Price</span><RangeSlider v-model="price" :min="0" :max="100" :step="5" /><span class="tnum text-right">{{ weights.price }}</span>
            <span>Speed</span><RangeSlider v-model="speed" :min="0" :max="100" :step="5" /><span class="tnum text-right">{{ weights.speed }}</span>
            <span>Reliability</span><RangeSlider v-model="reliability" :min="0" :max="100" :step="5" /><span class="tnum text-right">{{ weights.reliability }}</span>
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
