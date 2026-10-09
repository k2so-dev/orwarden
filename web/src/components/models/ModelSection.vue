<script setup lang="ts" vapor>
import { computed } from "vue";
import type { ModelView } from "@/lib/api";
import { money, pct, periodLabel } from "@/lib/format";
import { copy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Segmented from "@/components/app/Segmented.vue";
import StatusBadge from "@/components/app/StatusBadge.vue";
import { presetStatus, type PresetStatusInfo } from "@/lib/presetStatus";
import { columns, density, modelOpen, setModelOpen } from "@/stores/ui";
import { KINDS, kindOf } from "@/stores/filters";
import Tip from "@/components/app/Tip.vue";
import { overview, presets, presetsByModel, presetsFailed } from "@/stores/data";
import EndpointTable from "./EndpointTable.vue";
import PresetFooter from "./PresetFooter.vue";

const props = defineProps<{ model: ModelView; defaultOpen: boolean }>();

const open = computed(() => modelOpen.value.get(props.model.slug) ?? props.defaultOpen);
const toggle = () => setModelOpen(props.model.slug, !open.value);
const usageDays = computed(() => overview.value?.usageDays ?? 7);

const presetState = computed<PresetStatusInfo>(() => {
  if (!props.model.presetId) return { kind: "mute", text: "No preset", tip: "Only one provider serves this model, so there is nothing to route between.", copyable: false, create: false };
  const preset = presetsByModel.value.get(props.model.slug);
  if (presetsFailed.value) return { kind: "mute", text: "Status unavailable", tip: "Preset status failed to load. Refresh to retry.", copyable: false, create: false };
  if (presets.value === null) return { kind: "mute", text: "Loading", tip: "Preset status is not loaded yet.", copyable: false, create: false };
  if (!preset) return { kind: "mute", text: "Status unavailable", tip: "This model is not in the preset list yet. Refresh to load its status.", copyable: false, create: false };
  return presetStatus(preset);
});
const presetId = computed(() => presetsByModel.value.get(props.model.slug)?.presetId ?? props.model.presetId);
const copyPreset = () => {
  const preset = presetsByModel.value.get(props.model.slug);
  if (preset) void copy(preset.presetId);
};
const days = computed(() => overview.value?.horizonDays ?? 7);
const horizonLabel = computed(() => periodLabel(days.value));
const preset = computed(() => presetsByModel.value.get(props.model.slug));
const kind = computed(() => KINDS[kindOf(props.model.h, props.model.r)]);
const kindTip = computed(() => [
  { text: kind.value.hint, tone: "fg" as const },
  { text: `From ${usageDays.value}-day traffic: cache hit ${pct(props.model.h)}, output/input ${props.model.r.toFixed(2)}`, tone: "muted" as const },
]);

const COLUMN_ITEMS = [
  { key: "zt", label: "ZDR & Tools" },
  { key: "lat", label: "Latency" },
  { key: "share", label: "Traffic share" },
  { key: "brk", label: "Score breakdown" },
  { key: "stab", label: "Stability" },
] as const;

const DENSITY = [
  { value: "compact", label: "Compact" },
  { value: "comfortable", label: "Comfortable" },
];

const densityModel = computed({
  get: () => density.value,
  set: (v: string) => {
    density.value = v as "compact" | "comfortable";
  },
});
</script>

<template>
  <section class="rounded-xl border border-border bg-card">
    <div class="flex cursor-pointer flex-wrap items-center gap-3.5 px-4 py-3" role="button" tabindex="0" :aria-expanded="open" @click="toggle" @keydown.enter.self="toggle" @keydown.space.self.prevent="toggle">
      <svg :class="cn('size-4 transition-transform', !open && '-rotate-90')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="m6 9 6 6 6-6"></path>
      </svg>
      <div class="flex items-baseline gap-2">
        <span class="text-[15px] font-semibold">{{ model.name }}</span>
        <span class="font-mono text-xs text-muted-foreground">{{ model.slug }}</span>
        <span class="self-center" @click.stop><Tip :title="`Detected workload: ${kind.label}`" :lines="kindTip" class="h-5 items-center rounded-full border border-border px-2 text-[11.5px] font-medium">{{ kind.label }}</Tip></span>
      </div>
      <div class="tnum flex flex-wrap gap-4 text-[12.5px] text-muted-foreground">
        <span>{{ usageDays }}-day spend <b class="font-semibold text-foreground">{{ money(model.usageUsd) }}</b></span>
        <span>cache hit <b class="font-semibold text-foreground">{{ pct(model.h) }}</b></span>
        <span>out/in <b class="font-semibold text-foreground">{{ model.r.toFixed(2) }}</b></span>
        <span class="inline-flex items-center gap-1.5">
          {{ model.endpoints.length }} endpoints
          <span class="ml-1 size-1.5 rounded-full bg-ok"></span>{{ model.counts.ok }} ok
          <span class="ml-1 size-1.5 rounded-full bg-warn"></span>{{ model.counts.outlier }} outlier
          <span class="ml-1 size-1.5 rounded-full bg-bad"></span>{{ model.counts.hardBad }} bad
        </span>
      </div>
      <div class="ml-auto flex items-center gap-1.5" @click.stop @keydown.stop>
        <StatusBadge :kind="presetState.kind" :title="presetState.tip" class="h-[22px] px-2 text-[11.5px]">{{ presetState.text }}</StatusBadge>
        <button
          v-if="model.presetId"
          type="button"
          :disabled="!presetState.copyable"
          :title="presetState.copyable ? 'Copy the preset id' : presetState.tip"
          class="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 font-mono text-xs hover:bg-accent disabled:cursor-not-allowed disabled:text-muted-foreground"
          @click="copyPreset"
        >
          {{ presetId }}
          <svg class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect width="14" height="14" x="8" y="8" rx="2"></rect>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
          </svg>
        </button>
      </div>
    </div>
    <div v-if="open" class="border-t border-border">
      <div
        v-for="w in model.warnings"
        :key="w.title"
        :class="['mx-4 mt-3 flex items-center gap-2 rounded-lg px-3 py-[9px] text-[13px]', w.level === 'bad' ? 'bg-bad-bg text-bad' : 'bg-warn-bg text-warn']"
      >
        <svg class="size-[15px] flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path>
          <path d="M12 9v4M12 17h.01"></path>
        </svg>
        <span><b class="font-semibold">{{ w.title }}</b> <span class="text-foreground">{{ w.text }}</span></span>
      </div>
      <div class="flex items-center justify-between px-4 py-2.5">
        <span class="text-[13px] font-semibold">
          Endpoints <span class="font-normal text-muted-foreground">· tick rows to compose the preset · dimmed rows fail filters</span>
        </span>
        <Popover>
          <PopoverTrigger class="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium hover:bg-accent">
              <svg class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect width="18" height="18" x="3" y="3" rx="2"></rect>
                <path d="M9 3v18M15 3v18"></path>
              </svg>
              Columns
            </PopoverTrigger>
          <PopoverContent align="end" class="w-[220px] rounded-[10px] p-1.5">
            <div class="px-2 py-1 text-[11.5px] font-medium text-muted-foreground">Toggle columns</div>
            <button
              v-for="c in COLUMN_ITEMS"
              :key="c.key"
              type="button"
              class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-accent"
              @click="columns[c.key] = !columns[c.key]"
            >
              <span class="grid w-4 place-items-center">
                <svg v-if="columns[c.key]" class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
              </span>
              {{ c.label }}
            </button>
            <div class="mt-1.5 border-t border-border px-2 pb-1 pt-2 text-[11.5px] font-medium text-muted-foreground">Density</div>
            <Segmented v-model="densityModel" :options="DENSITY" size="sm" class="mx-1.5 mb-1 [&>button]:flex-1" />
          </PopoverContent>
        </Popover>
      </div>
      <EndpointTable :model="model" :horizon-label="horizonLabel" :preset="preset" />
      <PresetFooter v-if="preset" :preset="preset" />
    </div>
  </section>
</template>
