<script setup lang="ts" vapor>
import { computed } from "vue";
import Sparkline from "@/components/app/Sparkline.vue";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import type { EndpointView, ModelView, PresetView, TrendData } from "@/lib/api";
import { ago, money, pct, periodLabel, price, seconds, signedPct, uptime, volume } from "@/lib/format";
import { togglePick } from "@/lib/presetActions";
import { TONE_CLASS, verdictBadge, type TipLine } from "@/lib/issues";
import { cn } from "@/lib/utils";
import { view } from "@/stores/workload";
import { overview, settings } from "@/stores/data";
import { hideTip, showTip } from "@/stores/tip";

const props = defineProps<{
  row: EndpointView;
  position: number;
  model: ModelView;
  cols: { zt: boolean; lat: boolean; share: boolean; brk: boolean; stab: boolean };
  template: string;
  height: string;
  open: boolean;
  trend: TrendData | null;
  preset?: PresetView;
}>();
defineEmits<{ toggle: [] }>();

const dim = computed(() => !props.row.eligible);
const quantKind = computed<BadgeKind>(() => (props.row.quant === "low" ? "bad" : props.row.quant === "unknown" ? "mute" : props.row.quant === "closed" ? "none" : "out"));
const verdict = computed(() => verdictBadge(props.row));

const filterLines = computed(() => {
  const r = props.row;
  const out: string[] = [];
  if (props.model.profile.tools && !r.tools) out.push("tools not supported");
  if (view.value.zdrOnly && !r.zdr) out.push("no ZDR");
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


function tipVerdict(e: Event) {
  const title = props.row.verdict === "ok" ? "Verdict: ok" : `Verdict: ${props.row.verdict}`;
  showTip(e, title, reasons.value.length ? reasons.value : [{ text: "Price, cache, uptime and quantization are within rules.", tone: "muted" }]);
}
function tipBan(e: Event) {
  showTip(e, "Global ban status", [{ text: ban.value.tip, tone: "fg" }]);
}
function tipScore(e: Event) {
  const s = props.row.scores;
  const w = view.value.weights;
  const total = w.price + w.speed + w.reliability + w.stability || 1;
  const weighted = (s.price * w.price + s.speed * w.speed + s.reliability * w.reliability + s.stability * w.stability) / total;
  const penalty = props.row.quant === "unknown" ? Math.max(0, Math.round(weighted - s.overall)) : 0;
  const lines: TipLine[] = [
    {
      text: `(Price ${Math.round(s.price)} × ${w.price} + Speed ${Math.round(s.speed)} × ${w.speed} + Reliability ${Math.round(s.reliability)} × ${w.reliability} + Stability ${Math.round(s.stability)} × ${w.stability}) / ${total} = ${weighted.toFixed(1)}`,
      tone: "fg",
    },
  ];
  if (penalty > 0) lines.push({ text: `− ${penalty} for undisclosed quantization = ${Math.round(s.overall)}`, tone: "fg" });
  if (!props.row.tps || !props.row.latencyMs || props.row.latencyMs <= 0) lines.push({ text: "Speed uses a 30% placeholder where throughput or latency is unknown.", tone: "muted" });
  showTip(e, "Overall score", lines);
}

const upTone = computed(() => (props.row.uptime < view.value.minUptime / 100 ? "text-bad" : ""));
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
const breakdown = computed(() => {
  const r = props.row;
  const p = props.model.profile;
  const scale = (p.inputPerDay * horizonDays.value) / 1_000_000;
  const parts = [
    { label: p.h > 0 ? "Input (uncached)" : "Input", perM: (1 - p.h) * r.pIn, total: false },
    ...(p.h > 0 ? [{ label: "Cache read", perM: p.h * r.pCache, total: false }] : []),
    { label: "Output", perM: p.r * r.pOut, total: false },
  ];
  return [...parts, { label: "Total", perM: r.costPerM, total: true }].map((x) => ({ ...x, horizon: x.perM * scale }));
});
const volumeLabel = computed(() => `${volume(props.model.profile.inputPerDay)} input / day`);

const pickable = computed(() => props.row.eligible || props.row.presetRank !== null);
const pickReason = computed(() => (props.row.eligible ? null : (reasons.value[0]?.text ?? "Not eligible")));
const onPick = () => {
  if (props.preset) togglePick(props.preset, props.row.tag, pickReason.value);
};

const DAY = 86_400_000;
const BADGE_CHANGE = 0.1;
const WARM_MINUTES = 15;
const stab = computed(() => props.row.stability);
const takenAt = computed(() => Date.parse(overview.value?.takenAt ?? new Date().toISOString()));

const badges = computed(() => {
  const s = stab.value;
  const out: { text: string; kind: BadgeKind; tip: string }[] = [];
  if (s.isNew) out.push({ text: "new", kind: "mute", tip: `First seen ${ago(new Date(takenAt.value - (s.ageDays ?? 0) * DAY).toISOString(), takenAt.value)}. Stability stays near 50 until there are 7 days of history.` });
  if (s.lastChangeAt && s.lastChangePct !== null && Math.abs(s.lastChangePct) >= BADGE_CHANGE && takenAt.value - Date.parse(s.lastChangeAt) < 7 * DAY) {
    const up = s.lastChangePct > 0;
    out.push({ text: `${up ? "↑" : "↓"}${pct(Math.abs(s.lastChangePct))} ${ago(s.lastChangeAt, takenAt.value).replace(" ago", "")}`, kind: up ? "bad" : "ok", tip: `Blended price ${up ? "rose" : "fell"} ${pct(Math.abs(s.lastChangePct))} ${ago(s.lastChangeAt, takenAt.value)} at this workload.` });
  }
  if (s.verdictFlaps >= 3) out.push({ text: "flapping", kind: "warn", tip: `Verdict changed ${s.verdictFlaps} times in 30 days.` });
  const held = props.row.held;
  const p = settings.value?.presets;
  if (held && p) {
    out.push({
      text: "held",
      kind: "warn",
      tip: `Dropped from the preset ${ago(held.since, Date.now())}, kept while its conversations still use the cache. Extra spend so far ${money(held.overpayUsd)}. Goes after ${WARM_MINUTES} minutes without requests, ${p.holdHours} h or ${money(p.holdMaxUsd)} extra.`,
    });
  }
  return out;
});

const trendTone = computed(() => {
  const t = stab.value.priceTrend30d;
  if (t === null || Math.abs(t) < 0.005) return "text-muted-foreground";
  return t > 0 ? "text-bad" : "text-ok";
});
const trendText = computed(() => {
  const t = stab.value.priceTrend30d;
  if (t === null) return "—";
  return Math.abs(t) < 0.005 ? "0%" : signedPct(t);
});

function tipBadge(e: Event, tip: string) {
  showTip(e, "History", [{ text: tip, tone: "fg" }]);
}
function tipStability(e: Event) {
  const s = stab.value;
  const lines: TipLine[] = [
    { text: `Price: ${s.priceChanges} change${s.priceChanges === 1 ? "" : "s"} in 30 days, highest/lowest ${s.priceSwing.toFixed(2)}×`, tone: "fg" },
    { text: `7 days: ${signedPct(s.priceTrend7d)} · 30 days: ${signedPct(s.priceTrend30d)}`, tone: "fg" },
    { text: `Uptime: ${s.uptimeDips} day${s.uptimeDips === 1 ? "" : "s"} below the minimum, worst ${s.uptimeMin7d === null ? "—" : uptime(s.uptimeMin7d)} in 7 days`, tone: "fg" },
    { text: `Verdict flips: ${s.verdictFlaps}`, tone: "fg" },
  ];
  if (s.ageDays === null) lines.push({ text: "No history yet, scored as neutral 50.", tone: "muted" });
  else if (s.isNew) lines.push({ text: `Only ${s.ageDays.toFixed(1)} days of history, pulled towards 50.`, tone: "muted" });
  showTip(e, "Stability", lines);
}

const priceSteps = computed(() =>
  (props.trend?.events ?? []).filter((x) => x.tag === props.row.tag && x.slot === props.row.slot && x.kind !== "removed"),
);
const dailyPrices = computed(() => {
  const n = props.trend?.days ?? 30;
  const end = Math.floor(takenAt.value / DAY) * DAY + DAY;
  const out: { pIn: number; pOut: number }[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const cut = end - i * DAY;
    const last = priceSteps.value.filter((x) => Date.parse(x.ts) < cut).at(-1);
    if (last) out.push({ pIn: last.pIn, pOut: last.pOut });
  }
  return out;
});
const outSeries = computed(() => dailyPrices.value.map((p) => p.pOut));
const inSeries = computed(() => dailyPrices.value.map((p) => p.pIn));
const upSeries = computed(() => (props.trend?.daily ?? []).filter((d) => d.tag === props.row.tag).map((d) => d.uptimeMin));
const range = (v: number[]) => (v.length ? `$${price(Math.min(...v))}–$${price(Math.max(...v))}` : "—");
const outRange = computed(() => range(outSeries.value));
const inRange = computed(() => range(inSeries.value));
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
      <button
        v-if="preset"
        type="button"
        :aria-pressed="row.presetRank !== null"
        :title="row.presetRank !== null ? 'In the preset — click to remove' : pickable ? 'Add to the preset' : (pickReason ?? '')"
        :class="cn('tnum grid size-[18px] flex-none place-items-center rounded-[5px] border-[1.5px] text-[10.5px] font-bold', row.presetRank !== null ? 'border-primary bg-primary text-primary-foreground' : 'border-border', !pickable && 'opacity-35')"
        @click="onPick"
      >
        {{ row.presetRank ?? "" }}
      </button>
      <span v-else class="size-[18px] flex-none"></span>
      <button type="button" class="grid size-[22px] flex-none place-items-center rounded-md text-muted-foreground hover:bg-accent" @click="$emit('toggle')">
        <svg :class="cn('size-3.5 transition-transform', open && 'rotate-90')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m9 18 6-6-6-6"></path>
        </svg>
      </button>
      <span :class="cn('tnum w-[22px] text-right font-semibold', row.presetRank === null && 'text-muted-foreground')">{{ position }}</span>
      <div :class="cn('flex min-w-0 flex-col pl-1 leading-tight', dim && 'opacity-45')">
        <span class="flex items-center gap-1">
          <span class="font-medium">{{ row.providerName }}</span>
          <span v-for="b in badges" :key="b.text" class="inline-flex cursor-help" @mouseenter="tipBadge($event, b.tip)" @mouseleave="hideTip">
            <StatusBadge :kind="b.kind" class="h-4 px-1 text-[10px]">{{ b.text }}</StatusBadge>
          </span>
        </span>
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
    <template v-if="cols.stab">
      <div :class="cn(cell, 'tnum', dim && 'opacity-45')">
        <span :class="trendTone">{{ trendText }}</span><span v-if="stab.priceChanges > 0" class="text-muted-foreground"> · {{ stab.priceChanges }}</span>
      </div>
      <div class="cursor-help px-2.5" :class="dim && 'opacity-45'" @mouseenter="tipStability" @mouseleave="hideTip">
        <div :class="cn('tnum text-[12.5px]', stab.ageDays === null && 'text-muted-foreground')">{{ Math.round(row.scores.stability) }}</div>
        <div class="h-[3px] rounded-[2px] bg-muted"><div class="h-[3px] rounded-[2px] bg-muted-foreground" :style="{ width: `${row.scores.stability}%` }"></div></div>
      </div>
    </template>
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
    <div class="sticky left-0 grid w-[min(1120px,calc(100vw-90px))] grid-cols-[1.1fr_.9fr_1.2fr] gap-6 whitespace-normal pb-4 pl-12 pr-4 pt-3.5">
      <div>
        <div class="mb-1.5 text-xs font-semibold">Cost at this workload <span class="font-normal text-muted-foreground">· {{ volumeLabel }}</span></div>
        <div class="tnum grid grid-cols-[1fr_auto_auto] gap-x-[18px] gap-y-1 text-[12.5px]">
          <span class="text-[11.5px] text-muted-foreground">Part</span>
          <span class="text-right text-[11.5px] text-muted-foreground">per 1M in</span>
          <span class="text-right text-[11.5px] text-muted-foreground">per {{ periodLabel(horizonDays) }}</span>
          <template v-for="x in breakdown" :key="x.label">
            <span :class="x.total && 'font-semibold'">{{ x.label }}</span>
            <span :class="['text-right', x.total && 'font-semibold']">{{ money(x.perM) }}</span>
            <span :class="['text-right', x.total && 'font-semibold']">{{ money(x.horizon) }}</span>
          </template>
        </div>
      </div>
      <div class="flex flex-col gap-2.5">
        <div>
          <div class="flex justify-between text-xs"><b class="font-semibold">Output price · 30d</b><span class="tnum text-muted-foreground">{{ outRange }}</span></div>
          <Sparkline :values="outSeries" :width="160" :height="34" class="text-foreground" />
        </div>
        <div>
          <div class="flex justify-between text-xs"><b class="font-semibold">Input price · 30d</b><span class="tnum text-muted-foreground">{{ inRange }}</span></div>
          <Sparkline :values="inSeries" :width="160" :height="34" class="text-foreground" />
        </div>
        <div>
          <div class="flex justify-between text-xs"><b class="font-semibold">Daily worst uptime · 30d</b><span class="tnum text-muted-foreground">min {{ upMin }}</span></div>
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
