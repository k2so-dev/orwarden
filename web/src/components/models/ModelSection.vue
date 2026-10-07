<script setup lang="ts" vapor>
import { computed } from "vue";
import type { ModelView } from "@/lib/api";
import { money, pct, periodLabel, volume as vol } from "@/lib/format";
import { copy } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import Segmented from "@/components/app/Segmented.vue";
import { columns, density, openModels, toggleIn } from "@/stores/ui";
import { overview } from "@/stores/data";
import EndpointTable from "./EndpointTable.vue";
import ScenarioTable from "./ScenarioTable.vue";

const props = defineProps<{ model: ModelView; index: number }>();

const toggle = () => toggleIn(openModels, props.model.slug);
const open = computed(() => (props.index < 2) !== openModels.value.has(props.model.slug));
const days = computed(() => overview.value?.horizonDays ?? 7);
const horizonLabel = computed(() => periodLabel(days.value));
const volume = computed(() => (overview.value?.scenario.name === "actual" ? "actual volume" : `${vol(props.model.profile.inputPerDay)} input / day`));

const COLUMN_ITEMS = [
  { key: "zt", label: "ZDR & Tools" },
  { key: "lat", label: "Latency" },
  { key: "share", label: "Traffic share" },
  { key: "brk", label: "Score breakdown" },
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
    <div class="flex cursor-pointer flex-wrap items-center gap-3.5 px-4 py-3" @click="toggle">
      <svg :class="cn('size-4 transition-transform', !open && '-rotate-90')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="m6 9 6 6 6-6"></path>
      </svg>
      <div class="flex items-baseline gap-2">
        <span class="text-[15px] font-semibold">{{ model.name }}</span>
        <span class="font-mono text-xs text-muted-foreground">{{ model.slug }}</span>
      </div>
      <div class="tnum flex flex-wrap gap-4 text-[12.5px] text-muted-foreground">
        <span>7-day spend <b class="font-semibold text-foreground">{{ money(model.usageUsd) }}</b></span>
        <span>cache hit <b class="font-semibold text-foreground">{{ pct(model.h) }}</b></span>
        <span>out/in <b class="font-semibold text-foreground">{{ model.r.toFixed(2) }}</b></span>
        <span class="inline-flex items-center gap-1.5">
          {{ model.endpoints.length }} endpoints
          <span class="ml-1 size-1.5 rounded-full bg-ok"></span>{{ model.counts.ok }} ok
          <span class="ml-1 size-1.5 rounded-full bg-warn"></span>{{ model.counts.outlier }} outlier
          <span class="ml-1 size-1.5 rounded-full bg-bad"></span>{{ model.counts.hardBad }} bad
        </span>
      </div>
      <div class="ml-auto flex items-center gap-1.5" @click.stop>
        <code class="rounded-md bg-muted px-2 py-[5px] font-mono text-xs">{{ model.presetId }}</code>
        <button
          type="button"
          class="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-[12.5px] font-medium hover:bg-accent"
          @click="copy(model.presetId)"
        >
          <svg class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <rect width="14" height="14" x="8" y="8" rx="2"></rect>
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path>
          </svg>
          Copy
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
          Endpoints <span class="font-normal text-muted-foreground">· dimmed rows fail quality filters · hover a badge for the reason</span>
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
      <EndpointTable :model="model" :horizon-label="horizonLabel" />
      <div class="px-4 pb-4 pt-3.5">
        <div class="text-[13px] font-semibold">
          Scenario comparison <span class="font-normal text-muted-foreground">· {{ volume }} · {{ horizonLabel }}</span>
        </div>
        <ScenarioTable :model="model" />
      </div>
    </div>
  </section>
</template>
