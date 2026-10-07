<script setup lang="ts" vapor>
import { computed } from "vue";
import DeltaChip from "@/components/app/DeltaChip.vue";
import type { ModelView } from "@/lib/api";
import { money } from "@/lib/format";
import { overview } from "@/stores/data";

const props = defineProps<{ model: ModelView }>();

const LABELS: Record<string, string> = { actual: "Actual traffic", chat: "Chat", "chat-cached": "Chat + cache", agent: "Agent + tools", reasoning: "Reasoning" };

const rows = computed(() =>
  props.model.scenarios.map((s) => ({
    key: s.name,
    label: LABELS[s.name] ?? s.name,
    current: s.name === (overview.value?.scenario.name ?? "actual"),
    default: s.default,
    bans: s.bans,
    preset: s.preset,
    banDelta: s.default && s.bans !== null ? s.bans / s.default - 1 : null,
    presetDelta: s.default && s.preset !== null ? s.preset / s.default - 1 : null,
  })),
);
</script>

<template>
  <div class="mt-2 max-w-[820px] rounded-lg border border-border text-[12.5px] tnum">
    <div class="grid h-8 grid-cols-[1.1fr_1fr_1fr_1fr] items-center border-b border-border text-[11.5px] font-medium text-muted-foreground">
      <span class="px-3">Scenario</span>
      <span class="px-3 text-right">Default routing</span>
      <span class="px-3 text-right">With bans</span>
      <span class="px-3 text-right">With preset</span>
    </div>
    <div
      v-for="r in rows"
      :key="r.key"
      :class="['grid h-[34px] grid-cols-[1.1fr_1fr_1fr_1fr] items-center border-b border-border last:border-b-0', r.current && 'bg-muted font-semibold']"
    >
      <span class="px-3">{{ r.label }}</span>
      <span class="px-3 text-right">{{ money(r.default) }}</span>
      <span class="flex items-center justify-end gap-2 px-3">{{ money(r.bans) }}<DeltaChip :value="r.banDelta" class="min-w-11 justify-center" /></span>
      <span class="flex items-center justify-end gap-2 px-3">{{ money(r.preset) }}<DeltaChip :value="r.presetDelta" class="min-w-11 justify-center" /></span>
    </div>
  </div>
</template>
