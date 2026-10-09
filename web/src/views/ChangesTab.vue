<script setup lang="ts" vapor>
import { computed, ref } from "vue";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import Toggle from "@/components/app/Toggle.vue";
import type { ChangeRow } from "@/lib/api";
import { dateTime, pct, price, signedPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { changes } from "@/stores/data";

const significantOnly = ref(true);
const all = computed(() => changes.value?.changes ?? []);
const rows = computed(() => (significantOnly.value ? all.value.filter((c) => c.significant) : all.value));
const threshold = computed(() => pct(changes.value?.threshold ?? 0.1));
const days = computed(() => changes.value?.days ?? 30);

const GRID = "grid grid-cols-[120px_minmax(180px,1fr)_minmax(200px,1fr)_88px_150px_150px_130px_110px] min-w-[1100px] items-center";
const KIND: Record<ChangeRow["kind"], { kind: BadgeKind; text: string }> = {
  added: { kind: "ok", text: "added" },
  removed: { kind: "mute", text: "removed" },
  changed: { kind: "out", text: "changed" },
};

const tone = (v: number | null) => (v === null || Math.abs(v) < 0.005 ? "text-muted-foreground" : v > 0 ? "text-bad" : "text-ok");
const move = (c: ChangeRow, key: "pIn" | "pOut" | "pCache") => (c.prev && c.kind === "changed" ? `${price(c.prev[key])} → ${price(c.prices[key])}` : price(c.prices[key]));
const quant = (c: ChangeRow) => (c.prevQuantization && c.prevQuantization !== c.quantization ? `${c.prevQuantization} → ${c.quantization}` : c.quantization);
const rowKey = (c: ChangeRow) => `${c.ts}|${c.model}|${c.tag}|${c.slot}|${c.kind}`;
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-2.5 text-[13px]">
      <span class="font-semibold">Price changes</span>
      <span class="text-muted-foreground">Tracked models, last {{ days }} days. Changes at your workload, red is more expensive.</span>
      <label class="ml-auto flex items-center gap-2">
        <Toggle v-model="significantOnly" label="Significant only" />
        <span>Only moves of {{ threshold }} or more</span>
      </label>
    </div>
    <div v-if="rows.length === 0" class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <div class="text-[15px] font-semibold">No price changes yet</div>
      <div class="max-w-[460px] text-[13px] text-muted-foreground">Each refresh compares every endpoint of your tracked models with the last known price. Changes, new providers and removed providers show up here.</div>
    </div>
    <div v-else class="overflow-x-auto rounded-xl border border-border bg-card">
      <div :class="[GRID, 'h-[34px] border-b border-border bg-muted px-2 text-[11.5px] font-medium text-muted-foreground']">
        <span class="px-2">When</span>
        <span class="px-2">Model</span>
        <span class="px-2">Provider · endpoint</span>
        <span class="px-2">Change</span>
        <span class="px-2 text-right">Input</span>
        <span class="px-2 text-right">Output</span>
        <span class="px-2 text-right">Quant</span>
        <span class="px-2 text-right">At workload</span>
      </div>
      <div v-for="c in rows" :key="rowKey(c)" :class="[GRID, 'min-h-[42px] border-b border-border px-2 py-1 text-[12.5px] last:border-b-0']">
        <span class="tnum px-2 text-muted-foreground">{{ dateTime(c.ts) }}</span>
        <span class="truncate px-2 font-medium" :title="c.model">{{ c.modelName }}</span>
        <span class="flex min-w-0 flex-col px-2 leading-tight">
          <span class="truncate font-medium">{{ c.providerName }}</span>
          <span class="truncate font-mono text-[11px] text-muted-foreground">{{ c.tag }}</span>
        </span>
        <span class="px-2"><StatusBadge :kind="KIND[c.kind].kind">{{ KIND[c.kind].text }}</StatusBadge></span>
        <span :class="cn('tnum px-2 text-right', tone(c.inPct))">{{ move(c, "pIn") }}</span>
        <span :class="cn('tnum px-2 text-right', tone(c.outPct))">{{ move(c, "pOut") }}</span>
        <span :class="cn('px-2 text-right', c.prevQuantization && c.prevQuantization !== c.quantization ? 'text-warn' : 'text-muted-foreground')">{{ quant(c) }}</span>
        <span :class="cn('tnum px-2 text-right font-semibold', tone(c.blendedPct))">{{ c.blendedPct === null ? "—" : signedPct(c.blendedPct) }}</span>
      </div>
    </div>
  </div>
</template>
