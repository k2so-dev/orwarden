<script setup lang="ts" vapor>
import { computed } from "vue";
import DeltaChip from "@/components/app/DeltaChip.vue";
import type { ModelView } from "@/lib/api";
import { money } from "@/lib/format";
import { SCENARIOS } from "@/stores/filters";
import { overview } from "@/stores/data";

const props = defineProps<{ model: ModelView }>();

const label = (name: string) => SCENARIOS.find((s) => s.value === name)?.label ?? name;
const delta = (v: number | null, base: number | null) => (base && v !== null ? v / base - 1 : null);

const rows = computed(() =>
  props.model.scenarios
    .filter((s) => s.name !== "actual")
    .map((s) => ({
      key: s.name,
      label: label(s.name),
      current: s.name === overview.value?.scenario.name,
      default: s.default,
      bans: s.bans,
      preset: s.preset,
      banDelta: delta(s.bans, s.default),
      presetDelta: delta(s.preset, s.default),
    })),
);
</script>

<template>
  <div class="mt-2 max-w-[820px] rounded-lg border border-border text-[12.5px] tnum">
    <div class="grid h-8 grid-cols-[1.1fr_1fr_1fr_1fr] items-center border-b border-border text-[11.5px] font-medium text-muted-foreground">
      <span class="px-3">Scenario</span>
      <span class="px-3 text-right">Default routing</span>
      <span class="px-3 text-right">With bans</span>
      <span class="px-3 text-right">With saved preset</span>
    </div>
    <div
      v-for="r in rows"
      :key="r.key"
      :class="['grid h-[34px] grid-cols-[1.1fr_1fr_1fr_1fr] items-center border-b border-border last:border-b-0', r.current && 'bg-muted font-semibold']"
    >
      <span class="px-3">{{ r.label }}</span>
      <span class="px-3 text-right">{{ money(r.default) }}</span>
      <span class="flex items-center justify-end gap-2 px-3">{{ money(r.bans) }}<DeltaChip :value="r.banDelta" class="min-w-11" /></span>
      <span class="flex items-center justify-end gap-2 px-3">
        <span :class="r.preset === null && 'font-normal text-muted-foreground'">{{ r.preset === null ? "no preset" : money(r.preset) }}</span>
        <DeltaChip :value="r.presetDelta" class="min-w-11" />
      </span>
    </div>
  </div>
</template>
