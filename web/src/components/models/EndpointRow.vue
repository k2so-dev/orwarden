<script setup lang="ts" vapor>
import { computed } from "vue";
import Sparkline from "@/components/app/Sparkline.vue";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import type { EndpointView, HistoryPoint, ModelView } from "@/lib/api";
import { price, signedPct, uptime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { overview } from "@/stores/data";

const props = defineProps<{
  row: EndpointView;
  position: number;
  model: ModelView;
  cols: { zt: boolean; lat: boolean; share: boolean; brk: boolean };
  template: string;
  height: string;
  open: boolean;
  history: HistoryPoint[];
}>();
defineEmits<{ toggle: [] }>();

const dim = computed(() => !props.row.eligible);
const quantKind = computed<BadgeKind>(() => (props.row.quant === "low" ? "bad" : props.row.quant === "unknown" ? "mute" : "out"));
const verdictKind = computed<BadgeKind>(() => (props.row.verdict === "ok" ? "ok" : props.row.verdict === "outlier" ? "warn" : "bad"));
const verdictText = computed(() => (props.row.verdict === "ok" ? "ok" : `${props.row.verdict}: ${props.row.reasons[0] ?? ""}`));
const verdictTitle = computed(() => (props.row.reasons.length ? props.row.reasons.join("\n") : "Within all rules"));

const ban = computed(() => {
  const b = props.row.ban;
  if (b.auto) return { kind: "bad" as BadgeKind, text: "banned (auto)", title: "Banned automatically after repeated bad runs" };
  if (b.policy === "ban") return { kind: "bad" as BadgeKind, text: "banned (manual)", title: "Set by you" };
  if (b.inGuardrail) return { kind: "bad" as BadgeKind, text: "banned", title: "Present in the guardrail ignore list" };
  if (b.pending) return { kind: "warn" as BadgeKind, text: `pending ${b.pending.streak} of ${b.pending.needed} runs`, title: `Will ${b.pending.action} when the streak completes` };
  if (b.inDesired) return { kind: "warn" as BadgeKind, text: "+ ban pending", title: "In draft, not applied" };
  return { kind: "none" as BadgeKind, text: "—", title: "Not banned" };
});

const upTone = computed(() => (props.row.uptime < 0.97 ? "text-bad" : ""));
const omTone = computed(() => ((props.row.outVsMedian ?? 0) > 1.5 ? "text-bad" : ""));
const discTone = computed(() => (props.row.cacheKnown ? "" : "text-warn"));
const vsTone = computed(() => ((props.row.vsBest ?? 0) > 0.5 ? "text-bad" : "text-muted-foreground"));

const scenarioCosts = computed(() => {
  const r = props.row;
  const perDay = props.model.profile.inputPerDay;
  return [{ name: "actual", h: props.model.h, r: props.model.r }, ...props.model.scenarios.filter((s) => s.name !== "actual")].map((s) => {
    const cache = r.cacheKnown ? r.pCache : r.pIn;
    const perM = (1 - s.h) * r.pIn + s.h * cache + s.r * r.pOut;
    return { name: s.name, perM, horizon: (perM * perDay * horizonDays.value) / 1_000_000 };
  });
});

const series = computed(() => props.history.filter((p) => p.tag === props.row.tag));
const outSeries = computed(() => series.value.map((p) => p.pOut));
const upSeries = computed(() => series.value.map((p) => p.uptime));
const outRange = computed(() => (outSeries.value.length ? `${price(Math.min(...outSeries.value))}–${price(Math.max(...outSeries.value))}` : "—"));
const upMin = computed(() => (upSeries.value.length ? uptime(Math.min(...upSeries.value)) : "—"));

const horizonDays = computed(() => overview.value?.horizonDays ?? 7);
const cell = "px-2.5 text-right";
</script>

<template>
  <div
    class="grid w-max min-w-full items-center whitespace-nowrap border-b border-border text-[12.5px]"
    :style="{ gridTemplateColumns: template, height }"
  >
    <div class="sticky left-0 z-[1] flex h-full items-center gap-2 border-r border-border bg-card pl-2 pr-3">
      <button type="button" class="grid size-[22px] flex-none place-items-center rounded-md text-muted-foreground hover:bg-accent" @click="$emit('toggle')">
        <svg :class="cn('size-3.5 transition-transform', open && 'rotate-90')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6"></path>
        </svg>
      </button>
      <span :class="cn('tnum w-[22px] text-right font-semibold', dim && 'text-muted-foreground line-through', row.presetRank === null && !dim && 'font-normal text-muted-foreground')">{{ position }}</span>
      <div :class="cn('flex min-w-0 flex-col pl-1 leading-tight', dim && 'opacity-45')">
        <span class="font-medium">{{ row.providerName }}</span>
        <span class="font-mono text-[11px] text-muted-foreground">{{ row.tag }}</span>
      </div>
    </div>
    <div class="px-2.5" :class="dim && 'opacity-45'">
      <StatusBadge :kind="quantKind">{{ row.quantization }}</StatusBadge>
    </div>
    <template v-if="cols.zt">
      <div class="text-center" :class="dim && 'opacity-45'"><span v-if="row.zdr" class="text-ok">✓</span><span v-else class="text-muted-foreground">—</span></div>
      <div class="text-center" :class="dim && 'opacity-45'"><span v-if="row.tools" class="text-ok">✓</span><span v-else class="text-muted-foreground">—</span></div>
    </template>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ price(row.pIn) }}</div>
    <div :class="cn(cell, 'tnum', omTone, dim && 'opacity-45')">{{ price(row.pOut) }}</div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ price(row.pCache) }}</div>
    <div :class="cn(cell, 'tnum', discTone, dim && 'opacity-45')">{{ row.cacheDiscount === null ? "none" : `${Math.round(row.cacheDiscount * 100)}%` }}</div>
    <div :class="cn(cell, 'tnum', omTone, dim && 'opacity-45')">{{ row.outVsMedian === null ? "—" : `${row.outVsMedian.toFixed(2)}×` }}</div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">
      <span :class="upTone">{{ uptime(row.uptime) }}</span><span class="text-muted-foreground"> · {{ row.uptime30m === null ? "—" : uptime(row.uptime30m) }}</span>
    </div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ row.tps === null ? "—" : Math.round(row.tps) }}</div>
    <div v-if="cols.lat" :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ row.latencyMs === null ? "—" : `${Math.round(row.latencyMs)} ms` }}</div>
    <div v-if="cols.share" :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ row.defaultShare > 0 ? `${Math.round(row.defaultShare * 100)}%` : "—" }}</div>
    <div :class="cn(cell, 'tnum font-medium', dim && 'opacity-45')">${{ price(row.costPerM) }}</div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">${{ price(row.costHorizon) }}</div>
    <div :class="cn(cell, 'tnum', vsTone, dim && 'opacity-45')">{{ row.vsBest === null ? "—" : row.vsBest <= 0.0005 ? "best" : signedPct(row.vsBest) }}</div>
    <div v-if="cols.brk" class="grid grid-cols-3 gap-2 px-2.5 text-[11.5px]" :class="dim && 'opacity-45'">
      <div>
        <div class="tnum text-right">{{ Math.round(row.scores.price) }}</div>
        <div class="h-[3px] rounded-[2px] bg-muted"><div class="h-[3px] rounded-[2px] bg-muted-foreground" :style="{ width: `${row.scores.price}%` }"></div></div>
      </div>
      <div>
        <div class="tnum text-right">{{ Math.round(row.scores.speed) }}</div>
        <div class="h-[3px] rounded-[2px] bg-muted"><div class="h-[3px] rounded-[2px] bg-muted-foreground" :style="{ width: `${row.scores.speed}%` }"></div></div>
      </div>
      <div>
        <div class="tnum text-right">{{ Math.round(row.scores.reliability) }}</div>
        <div class="h-[3px] rounded-[2px] bg-muted"><div class="h-[3px] rounded-[2px] bg-muted-foreground" :style="{ width: `${row.scores.reliability}%` }"></div></div>
      </div>
    </div>
    <div class="px-2.5" :class="dim && 'opacity-45'" :title="`Price ${row.scores.price} · Speed ${row.scores.speed} · Reliability ${row.scores.reliability}`">
      <div class="tnum text-[13px] font-bold">{{ Math.round(row.scores.overall) }}</div>
      <div class="h-1 rounded-[2px] bg-muted"><div class="h-1 rounded-[2px] bg-foreground" :style="{ width: `${row.scores.overall}%` }"></div></div>
    </div>
    <div class="px-2.5" :title="verdictTitle"><StatusBadge :kind="verdictKind" class="cursor-help">{{ verdictText }}</StatusBadge></div>
    <div class="px-2.5" :title="ban.title"><StatusBadge :kind="ban.kind" class="cursor-help">{{ ban.text }}</StatusBadge></div>
  </div>
  <div v-if="open" class="w-max min-w-full border-b border-border bg-muted">
    <div class="sticky left-0 grid w-[min(1120px,calc(100vw-90px))] grid-cols-[1.1fr_.9fr_1.2fr] gap-6 whitespace-normal py-3.5 pl-12 pr-4">
      <div>
        <div class="mb-1.5 text-xs font-semibold">Cost by scenario <span class="font-normal text-muted-foreground">· {{ (model.profile.inputPerDay / 1_000_000).toFixed(1) }}M in/day</span></div>
        <div class="tnum grid grid-cols-[1fr_auto_auto] gap-x-[18px] gap-y-1 text-[12.5px]">
          <span class="text-[11.5px] text-muted-foreground">Scenario</span>
          <span class="text-right text-[11.5px] text-muted-foreground">per 1M in</span>
          <span class="text-right text-[11.5px] text-muted-foreground">per {{ horizonDays }} days</span>
          <template v-for="s in scenarioCosts" :key="s.name">
            <span>{{ s.name }}</span>
            <span class="text-right">${{ price(s.perM) }}</span>
            <span class="text-right">${{ price(s.horizon) }}</span>
          </template>
        </div>
      </div>
      <div class="flex flex-col gap-2.5">
        <div>
          <div class="flex justify-between text-xs"><b class="font-semibold">Output price · 7d</b><span class="tnum text-muted-foreground">{{ outRange }}</span></div>
          <Sparkline :values="outSeries" :width="160" :height="34" class="text-foreground" />
        </div>
        <div>
          <div class="flex justify-between text-xs"><b class="font-semibold">Uptime · 7d</b><span class="tnum text-muted-foreground">min {{ upMin }}</span></div>
          <Sparkline :values="upSeries" :width="160" :height="34" class="text-ok" />
        </div>
      </div>
      <div>
        <div class="mb-1.5 text-xs font-semibold">Reasons</div>
        <div class="flex flex-col gap-1">
          <div v-if="row.reasons.length === 0" class="flex gap-2 text-[12.5px]"><span class="text-ok">●</span><span>Within all rules</span></div>
          <div v-for="r in row.reasons" :key="r" class="flex gap-2 text-[12.5px]">
            <span :class="row.verdict === 'hard-bad' ? 'text-bad' : 'text-warn'">●</span><span class="text-pretty">{{ r }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
