<script setup lang="ts" vapor>
import { computed, ref, watch } from "vue";
import RangeSlider from "@/components/app/RangeSlider.vue";
import Segmented from "@/components/app/Segmented.vue";
import Toggle from "@/components/app/Toggle.vue";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ModelOverrides, ModelView } from "@/lib/api";
import { patchPreset } from "@/lib/presetActions";
import { cn } from "@/lib/utils";
import { settings } from "@/stores/data";
import { QUANT_OPTIONS } from "@/stores/filters";
import { view } from "@/stores/workload";

type Key = keyof ModelOverrides;

const props = defineProps<{ model: ModelView }>();

const draft = ref<ModelOverrides>({ ...props.model.overrides });
let timer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => JSON.stringify(props.model.overrides),
  () => {
    if (timer === undefined) draft.value = { ...props.model.overrides };
  },
);

const count = computed(() => Object.keys(props.model.overrides).length);

function globals(): Required<ModelOverrides> {
  const v = view.value;
  return {
    workload: { mode: v.actual ? "actual" : "custom", h: v.cache, r: v.ratio, tokensPerDay: Math.round(v.volumeM * 1_000_000) },
    requireTools: v.tools,
    minQuantization: v.minQuant,
    minUptime: v.minUptime / 100,
    zdrOnly: v.zdrOnly,
    scoring: { ...v.weights },
    topN: settings.value?.presets.topN ?? 5,
  };
}

const current = computed<Required<ModelOverrides>>(() => ({ ...globals(), ...draft.value }) as Required<ModelOverrides>);
const own = (key: Key) => draft.value[key] !== undefined;

function save(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void patchPreset(props.model.slug, { overrides: draft.value });
  }, 500);
}

function set<K extends Key>(key: K, value: ModelOverrides[K]): void {
  draft.value = { ...draft.value, [key]: value };
  save();
}

function toggle(key: Key, on: boolean): void {
  const next = { ...draft.value };
  if (on) Object.assign(next, { [key]: globals()[key] });
  else delete next[key];
  draft.value = next;
  save();
}

function reset(): void {
  draft.value = {};
  save();
}

const workload = computed(() => current.value.workload);
const setWorkload = (patch: Partial<Required<ModelOverrides>["workload"]>) => set("workload", { ...workload.value, ...patch });
const cache = computed({ get: () => Math.round(workload.value.h * 100), set: (v: number) => setWorkload({ mode: "custom", h: v / 100 }) });
const ratio = computed({ get: () => workload.value.r, set: (v: number) => setWorkload({ mode: "custom", r: v }) });
const tools = computed({ get: () => current.value.requireTools, set: (v: boolean) => set("requireTools", v) });
const quant = computed({ get: () => current.value.minQuantization, set: (v: string) => set("minQuantization", v) });
const uptime = computed({ get: () => Number((current.value.minUptime * 100).toFixed(2)), set: (v: number) => set("minUptime", v / 100) });
const zdr = computed({ get: () => current.value.zdrOnly, set: (v: boolean) => set("zdrOnly", v) });
const weights = computed(() => current.value.scoring);
const setWeight = (key: keyof Required<ModelOverrides>["scoring"], v: number) => set("scoring", { ...weights.value, [key]: v });
const price = computed({ get: () => weights.value.price, set: (v: number) => setWeight("price", v) });
const speed = computed({ get: () => weights.value.speed, set: (v: number) => setWeight("speed", v) });
const reliability = computed({ get: () => weights.value.reliability, set: (v: number) => setWeight("reliability", v) });
const stability = computed({ get: () => weights.value.stability, set: (v: number) => setWeight("stability", v) });

function onVolume(e: Event): void {
  const input = e.target as HTMLInputElement;
  const v = Number(input.value);
  if (Number.isFinite(v) && v > 0) setWorkload({ mode: "custom", tokensPerDay: Math.round(v * 1_000_000) });
  else input.value = String(workload.value.tokensPerDay / 1_000_000);
}

function onTopN(e: Event): void {
  const input = e.target as HTMLInputElement;
  const v = Math.round(Number(input.value));
  if (Number.isFinite(v) && v >= 1 && v <= 20) set("topN", v);
  else input.value = String(current.value.topN);
}

const ROWS: { key: Key; label: string }[] = [
  { key: "workload", label: "Workload" },
  { key: "requireTools", label: "Require tool calling" },
  { key: "minQuantization", label: "Min quantization" },
  { key: "minUptime", label: "Min uptime · 1d" },
  { key: "zdrOnly", label: "ZDR only" },
  { key: "scoring", label: "Efficiency weights" },
  { key: "topN", label: "Top N providers" },
];

const field = "flex flex-col gap-2 border-t border-border py-2.5 first:border-t-0";
const dim = (key: Key) => cn("flex flex-wrap items-center gap-x-3 gap-y-2 pl-[42px] text-[12.5px]", !own(key) && "pointer-events-none opacity-45");
const numBox = "tnum h-7 w-14 rounded-md border border-border bg-background px-2 text-right text-[12.5px] outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none";
</script>

<template>
  <Popover>
    <PopoverTrigger :class="cn('inline-flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium hover:bg-accent', count > 0 ? 'border-primary bg-primary/10' : 'border-border bg-background')">
      <svg class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 7h-9"></path><path d="M14 17H5"></path><circle cx="17" cy="17" r="3"></circle><circle cx="7" cy="7" r="3"></circle></svg>
      Model rules
      <span v-if="count > 0" class="tnum rounded bg-primary px-1 text-[11px] text-primary-foreground">{{ count }}</span>
    </PopoverTrigger>
    <PopoverContent align="end" class="flex max-h-[min(640px,80vh)] w-[400px] flex-col overflow-y-auto rounded-[10px] p-3.5">
      <div class="flex items-start justify-between gap-3 pb-2">
        <div>
          <div class="text-[13px] font-semibold">Rules for {{ model.name }}</div>
          <div class="text-xs text-muted-foreground">Switch a rule on to replace the header value for this model. Prices, scores and its preset follow.</div>
        </div>
        <button v-if="Object.keys(draft).length > 0" type="button" class="shrink-0 text-xs text-muted-foreground hover:text-foreground" @click="reset">Reset all</button>
      </div>
      <div v-for="r in ROWS" :key="r.key" :class="field">
        <label class="flex items-center gap-2.5 text-[12.5px]">
          <Toggle :model-value="own(r.key)" :label="`Own ${r.label}`" @update:model-value="toggle(r.key, $event)" />
          <span :class="own(r.key) ? 'font-medium' : 'text-muted-foreground'">{{ r.label }}</span>
          <span v-if="!own(r.key)" class="ml-auto text-[11.5px] text-muted-foreground">from header</span>
        </label>
        <div v-if="r.key === 'workload'" :class="dim(r.key)">
          <button
            type="button"
            :aria-pressed="workload.mode === 'actual'"
            :class="['h-[26px] rounded-[7px] border px-2.5 text-xs font-medium', workload.mode === 'actual' ? 'border-primary bg-primary text-primary-foreground' : 'border-border hover:bg-accent']"
            @click="setWorkload({ mode: workload.mode === 'actual' ? 'custom' : 'actual' })"
          >
            Actual
          </button>
          <span class="flex items-center gap-2">Cache <RangeSlider v-model="cache" class="w-20" :min="0" :max="95" :step="5" /><span class="tnum w-8">{{ cache }}%</span></span>
          <span class="flex items-center gap-2">Out/in <RangeSlider v-model="ratio" class="w-20" :min="0" :max="2" :step="0.05" /><span class="tnum w-8">{{ ratio.toFixed(2) }}</span></span>
          <span class="flex items-center gap-1.5">
            <input type="number" min="0.1" step="0.5" :value="workload.tokensPerDay / 1_000_000" aria-label="Million input tokens per day" :class="numBox" @change="onVolume" />
            <span class="text-xs text-muted-foreground">M in/day</span>
          </span>
        </div>
        <div v-else-if="r.key === 'requireTools'" :class="dim(r.key)"><Toggle v-model="tools" label="Require tool calling" /></div>
        <div v-else-if="r.key === 'minQuantization'" :class="dim(r.key)"><Segmented v-model="quant" :options="QUANT_OPTIONS" size="sm" /></div>
        <div v-else-if="r.key === 'minUptime'" :class="dim(r.key)">
          <RangeSlider v-model="uptime" class="w-[140px]" :min="90" :max="100" :step="0.5" /><span class="tnum">{{ uptime }}%</span>
        </div>
        <div v-else-if="r.key === 'zdrOnly'" :class="dim(r.key)"><Toggle v-model="zdr" label="ZDR only" /></div>
        <div v-else-if="r.key === 'scoring'" :class="cn(dim(r.key), 'grid grid-cols-[72px_1fr_28px] gap-x-2.5 gap-y-2')">
          <span>Price</span><RangeSlider v-model="price" :min="0" :max="100" :step="5" /><span class="tnum text-right">{{ weights.price }}</span>
          <span>Speed</span><RangeSlider v-model="speed" :min="0" :max="100" :step="5" /><span class="tnum text-right">{{ weights.speed }}</span>
          <span>Reliability</span><RangeSlider v-model="reliability" :min="0" :max="100" :step="5" /><span class="tnum text-right">{{ weights.reliability }}</span>
          <span>Stability</span><RangeSlider v-model="stability" :min="0" :max="100" :step="5" /><span class="tnum text-right">{{ weights.stability }}</span>
        </div>
        <div v-else-if="r.key === 'topN'" :class="dim(r.key)">
          <input type="number" min="1" max="20" step="1" :value="current.topN" aria-label="Top N providers" :class="numBox" @change="onTopN" />
          <span class="text-xs text-muted-foreground">providers in the preset unless ticked by hand</span>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>
