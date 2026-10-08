<script setup lang="ts" vapor>
import { computed } from "vue";
import Sparkline from "@/components/app/Sparkline.vue";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import type { EndpointView, HistoryPoint, ModelView } from "@/lib/api";
import { money, pct, periodLabel, price, seconds, uptime, volume } from "@/lib/format";
import { TONE_CLASS, verdictBadge, type TipLine } from "@/lib/issues";
import { cn } from "@/lib/utils";
import { filters, scenarioLabel } from "@/stores/filters";
import { overview, settings } from "@/stores/data";
import { hideTip, showTip } from "@/stores/tip";

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
const rankText = computed(() => props.row.presetRank ?? props.position);
const quantKind = computed<BadgeKind>(() => (props.row.quant === "low" ? "bad" : props.row.quant === "unknown" ? "mute" : props.row.quant === "closed" ? "none" : "out"));
const verdict = computed(() => verdictBadge(props.row));

const filterLines = computed(() => {
  const r = props.row;
  const out: string[] = [];
  if (props.model.profile.tools && !r.tools) out.push("tools not supported");
  if (filters.value.zdrOnly && !r.zdr) out.push("no ZDR");
  if (r.ban.inDesired) out.push("provider is banned");
  return out;
});

const reasons = computed<TipLine[]>(() => [
  ...props.row.issues.map((i) => ({ text: i.text, tone: i.level === "bad" ? ("bad" as const) : ("warn" as const) })),
  ...filterLines.value.map((f) => ({ text: `Filter: ${f}`, tone: "muted" as const })),
]);

const ban = computed(() => {
  const b = props.row.ban;
  const runs = settings.value?.optimizer.hysteresis.banAfterRuns ?? 2;
  if (b.inGuardrail && b.inDesired) {
    return b.auto
      ? { kind: "bad" as BadgeKind, text: "banned (auto)", tip: `Auto-banned: bad on ${runs} of ${runs} consecutive runs. Applies to every model and every app.` }
      : { kind: "bad" as BadgeKind, text: "banned (manual)", tip: "Banned manually. Applies to every model and every app." };
  }
  if (b.inGuardrail) return { kind: "warn" as BadgeKind, text: "unban pending", tip: "Unban is in the draft — press Apply on the Providers tab." };
  if (b.inDesired) return { kind: "warn" as BadgeKind, text: "ban pending", tip: "Ban is in the draft — not written yet. Press Apply on the Providers tab." };
  if (b.pending?.action === "ban") {
    return { kind: "warn" as BadgeKind, text: "candidate", tip: `Ban candidate (${b.pending.streak} of ${b.pending.needed} runs). Auto-ban after ${b.pending.needed} consecutive bad runs.` };
  }
  return { kind: "none" as BadgeKind, text: "—", tip: "Not banned. Global bans remove a provider from all models." };
});

const weights = computed(() => {
  const f = filters.value;
  const total = f.wPrice + f.wSpeed + f.wReliability || 1;
  return { p: Math.round((f.wPrice / total) * 100), s: Math.round((f.wSpeed / total) * 100), r: Math.round((f.wReliability / total) * 100) };
});

function tipVerdict(e: Event) {
  const title = props.row.verdict === "ok" ? "Verdict: ok" : `Verdict: ${props.row.verdict}`;
  showTip(e, title, reasons.value.length ? reasons.value : [{ text: "Price, cache, uptime and quantization are within rules.", tone: "muted" }]);
}
function tipBan(e: Event) {
  showTip(e, "Global ban status", [{ text: ban.value.tip, tone: "fg" }]);
}
function tipScore(e: Event) {
  const s = props.row.scores;
  const w = weights.value;
  const speed = props.row.tps === null ? "—" : Math.round(s.speed);
  showTip(e, "Overall score", [
    { text: `Price ${Math.round(s.price)} × ${w.p}% + Speed ${speed} × ${w.s}% + Reliability ${Math.round(s.reliability)} × ${w.r}% = ${Math.round(s.overall)}`, tone: "fg" },
  ]);
}

const upTone = computed(() => (props.row.uptime < (filters.value.minUptime ?? 97) / 100 ? "text-bad" : ""));
const outThresholds = computed(() => settings.value?.filters.outliers ?? { outVsMedian: 1.5, hardOutVsMedian: 2.5 });
const omTone = computed(() => {
  const v = props.row.outVsMedian ?? 0;
  return v >= outThresholds.value.hardOutVsMedian ? "text-bad" : v >= outThresholds.value.outVsMedian ? "text-warn" : "";
});
const discTone = computed(() => (props.row.cacheDiscount === null ? "text-warn" : ""));
const vsTone = computed(() => {
  const v = props.row.vsBest;
  if (v === null) return "text-muted-foreground";
  if (Math.abs(v) < 0.005) return "text-ok";
  if (v < 0) return "text-muted-foreground";
  return v > 0.5 ? "text-bad" : "";
});
const vsText = computed(() => {
  const v = props.row.vsBest;
  if (v === null) return "—";
  if (Math.abs(v) < 0.005) return "best";
  return `${v > 0 ? "+" : "−"}${pct(Math.abs(v))}`;
});

const horizonDays = computed(() => overview.value?.horizonDays ?? 7);
const scenarioCosts = computed(() => {
  const r = props.row;
  return props.model.scenarios
    .filter((s) => s.name !== "actual")
    .map((s) => {
      const perM = (1 - s.h) * r.pIn + s.h * r.pCache + s.r * r.pOut;
      return {
        name: s.name,
        label: `${scenarioLabel(s.name)} · ${volume(s.inputPerDay)}/day`,
        current: s.name === overview.value?.scenario.name,
        perM,
        horizon: (perM * s.inputPerDay * horizonDays.value) / 1_000_000,
      };
    });
});

const series = computed(() => props.history.filter((p) => p.tag === props.row.tag));
const outSeries = computed(() => series.value.map((p) => p.pOut));
const upSeries = computed(() => series.value.map((p) => p.uptime));
const outRange = computed(() => (outSeries.value.length ? `$${price(Math.min(...outSeries.value))}–$${price(Math.max(...outSeries.value))}` : "—"));
const upMin = computed(() => (upSeries.value.length ? uptime(Math.min(...upSeries.value)) : "—"));
const detailReasons = computed<TipLine[]>(() => (reasons.value.length ? reasons.value : [{ text: "No issues found.", tone: "muted" }]));

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
      <span :class="cn('tnum w-[22px] text-right font-semibold', row.presetRank === null && 'font-normal text-muted-foreground', dim && 'line-through')">{{ rankText }}</span>
      <div :class="cn('flex min-w-0 flex-col pl-1 leading-tight', dim && 'opacity-45')">
        <span class="font-medium">{{ row.providerName }}</span>
        <span class="font-mono text-[11px] text-muted-foreground">{{ row.tag }}</span>
      </div>
    </div>
    <div class="px-2.5" :class="dim && 'opacity-45'">
      <StatusBadge :kind="quantKind">{{ row.quant === "closed" ? "closed" : row.quantization }}</StatusBadge>
    </div>
    <template v-if="cols.zt">
      <div class="text-center" :class="dim && 'opacity-45'"><span v-if="row.zdr" class="text-ok">✓</span><span v-else class="text-muted-foreground">—</span></div>
      <div class="text-center" :class="dim && 'opacity-45'"><span v-if="row.tools" class="text-ok">✓</span><span v-else class="text-muted-foreground">—</span></div>
    </template>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ price(row.pIn) }}</div>
    <div :class="cn(cell, 'tnum', omTone, dim && 'opacity-45')">{{ price(row.pOut) }}</div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ price(row.pCache) }}</div>
    <div :class="cn(cell, 'tnum', discTone, dim && 'opacity-45')">{{ row.cacheDiscount === null ? "none" : pct(row.cacheDiscount) }}</div>
    <div :class="cn(cell, 'tnum', omTone, dim && 'opacity-45')">{{ row.outVsMedian === null ? "—" : `${row.outVsMedian.toFixed(2)}×` }}</div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">
      <span :class="upTone">{{ uptime(row.uptime) }}</span><span class="text-muted-foreground"> · {{ row.uptime30m === null ? "—" : uptime(row.uptime30m) }}</span>
    </div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ row.tps === null ? "—" : Math.round(row.tps) }}</div>
    <div v-if="cols.lat" :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ seconds(row.latencyMs) }}</div>
    <div v-if="cols.share" :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ row.defaultShare > 0 ? pct(row.defaultShare, 1) : "—" }}</div>
    <div :class="cn(cell, 'tnum font-medium', dim && 'opacity-45')">{{ money(row.costPerM) }}</div>
    <div :class="cn(cell, 'tnum', dim && 'opacity-45')">{{ money(row.costHorizon) }}</div>
    <div :class="cn(cell, 'tnum', vsTone, dim && 'opacity-45')">{{ vsText }}</div>
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
    <div class="cursor-help px-2.5" :class="dim && 'opacity-45'" @mouseenter="tipScore" @mouseleave="hideTip">
      <div class="tnum text-[13px] font-bold">{{ Math.round(row.scores.overall) }}</div>
      <div class="h-1 rounded-[2px] bg-muted"><div class="h-1 rounded-[2px] bg-foreground" :style="{ width: `${row.scores.overall}%` }"></div></div>
    </div>
    <div class="min-w-0 px-2.5" :class="dim && 'opacity-45'">
      <span class="inline-flex max-w-full cursor-help" @mouseenter="tipVerdict" @mouseleave="hideTip">
        <StatusBadge :kind="verdict.kind" class="max-w-full truncate">{{ verdict.text }}</StatusBadge>
      </span>
    </div>
    <div class="px-2.5" :class="dim && 'opacity-45'">
      <span class="inline-flex cursor-help" @mouseenter="tipBan" @mouseleave="hideTip">
        <StatusBadge :kind="ban.kind">{{ ban.text }}</StatusBadge>
      </span>
    </div>
  </div>
  <div v-if="open" class="w-max min-w-full border-b border-border bg-muted">
    <div class="sticky left-0 grid w-[min(1120px,calc(100vw-90px))] grid-cols-[1.1fr_.9fr_1.2fr] gap-6 whitespace-normal py-3.5 pl-12 pr-4">
      <div>
        <div class="mb-1.5 text-xs font-semibold">Cost by scenario</div>
        <div class="tnum grid grid-cols-[1fr_auto_auto] gap-x-[18px] gap-y-1 text-[12.5px]">
          <span class="text-[11.5px] text-muted-foreground">Scenario</span>
          <span class="text-right text-[11.5px] text-muted-foreground">per 1M in</span>
          <span class="text-right text-[11.5px] text-muted-foreground">per {{ periodLabel(horizonDays) }}</span>
          <template v-for="s in scenarioCosts" :key="s.name">
            <span :class="s.current && 'font-semibold'">{{ s.label }}</span>
            <span :class="['text-right', s.current && 'font-semibold']">{{ money(s.perM) }}</span>
            <span :class="['text-right', s.current && 'font-semibold']">{{ money(s.horizon) }}</span>
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
          <div v-for="r in detailReasons" :key="r.text" class="flex gap-2 text-[12.5px]">
            <span :class="TONE_CLASS[r.tone]">●</span><span class="text-pretty">{{ r.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
