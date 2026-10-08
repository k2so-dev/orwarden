<script setup lang="ts" vapor>
import { computed } from "vue";
import type { EndpointView, ModelView, PresetView } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ensureHistory, historyCache } from "@/stores/data";
import { columns, DEFAULT_SORT, density, openRows, sortBy, sortStates, toggleIn } from "@/stores/ui";
import EndpointRow from "./EndpointRow.vue";

const props = defineProps<{ model: ModelView; horizonLabel: string; preset?: PresetView }>();

type SortKey = "rank" | "in" | "out" | "cache" | "disc" | "om" | "up" | "tps" | "lat" | "share" | "perM" | "hz" | "vs" | "overall" | "verdict" | "ban";

const SEVERITY: Record<string, number> = { ok: 0, outlier: 1, "hard-bad": 2 };

const VALUE: Record<SortKey, (e: EndpointView, i: number) => number> = {
  rank: (e, i) => (e.presetRank ?? 1000) * 1e6 + (e.eligible ? 0 : 1e5) + (100 - e.scores.overall) * 100 + i / 1000,
  in: (e) => e.pIn,
  out: (e) => e.pOut,
  cache: (e) => e.pCache,
  disc: (e) => e.cacheDiscount ?? -1,
  om: (e) => e.outVsMedian ?? 0,
  up: (e) => e.uptime,
  tps: (e) => e.tps ?? -1,
  lat: (e) => e.latencyMs ?? Number.POSITIVE_INFINITY,
  share: (e) => e.defaultShare,
  perM: (e) => e.costPerM,
  hz: (e) => e.costHorizon,
  vs: (e) => e.vsBest ?? 0,
  overall: (e) => e.scores.overall,
  verdict: (e) => SEVERITY[e.verdict] ?? 0,
  ban: (e) => (e.ban.inGuardrail ? 2 : 0) + (e.ban.inDesired ? 1 : 0),
};

const sortState = computed(() => sortStates.value.get(props.model.slug) ?? DEFAULT_SORT);
const rows = computed(() => {
  const { key, dir } = sortState.value;
  const seen = new Map<string, number>();
  const indexed = props.model.endpoints.map((e, i) => {
    const n = seen.get(e.tag) ?? 0;
    seen.set(e.tag, n + 1);
    return { e, i, id: `${e.tag}:${n}` };
  });
  const ranked = [...indexed].sort((a, b) => VALUE.rank(a.e, a.i) - VALUE.rank(b.e, b.i));
  const position = new Map(ranked.map((x, n) => [x.id, n + 1]));
  const get = VALUE[(key in VALUE ? key : "rank") as SortKey];
  const sign = dir === "asc" ? 1 : -1;
  return indexed
    .map((x) => ({ ...x, v: get(x.e, x.i) }))
    .sort((a, b) => (a.v - b.v) * sign || a.i - b.i)
    .map(({ e, id }) => ({ e, id, position: position.get(id)! }));
});

const template = computed(() => {
  const c = columns.value;
  const parts = ["262px", "76px"];
  if (c.zt) parts.push("46px", "50px");
  parts.push("62px", "62px", "70px", "66px", "70px", "116px", "60px");
  if (c.lat) parts.push("64px");
  if (c.share) parts.push("64px");
  parts.push("78px", "88px", "70px");
  if (c.brk) parts.push("156px");
  parts.push("78px", "150px", "minmax(136px,1fr)");
  return parts.join(" ");
});

const height = computed(() => (density.value === "compact" ? "38px" : "50px"));
const history = computed(() => historyCache.value.get(props.model.slug) ?? []);

const rowKey = (id: string) => `${props.model.slug}|${id}`;

function toggle(id: string): void {
  toggleIn(openRows, rowKey(id));
  void ensureHistory(props.model.slug);
}

const HEADERS = computed(() => {
  const c = columns.value;
  const h: { key: SortKey | null; label: string; align: string; title?: string }[] = [{ key: null, label: "Quant", align: "" }];
  if (c.zt) h.push({ key: null, label: "ZDR", align: "text-center" }, { key: null, label: "Tools", align: "text-center" });
  h.push(
    { key: "in", label: "In", align: "text-right" },
    { key: "out", label: "Out", align: "text-right" },
    { key: "cache", label: "Cache rd", align: "text-right" },
    { key: "disc", label: "Cache disc", align: "text-right" },
    { key: "om", label: "Out/med", align: "text-right" },
    { key: "up", label: "Uptime 1d · 30m", align: "text-right" },
    { key: "tps", label: "tok/s", align: "text-right" },
  );
  if (c.lat) h.push({ key: "lat", label: "Latency", align: "text-right" });
  if (c.share) h.push({ key: "share", label: "Share", align: "text-right" });
  h.push(
    { key: "perM", label: "$ / 1M in", align: "text-right", title: "Blended cost per 1M input tokens for this workload: uncached input + cached input + output at the scenario's output/input ratio" },
    { key: "hz", label: `$ / ${props.horizonLabel}`, align: "text-right" },
    { key: "vs", label: "vs best", align: "text-right", title: "Blended cost compared with the cheapest endpoint that passes the current filters" },
  );
  return h;
});

const indicator = (key: string | null) => (key && sortState.value.key === key ? (sortState.value.dir === "asc" ? " ↑" : " ↓") : "");
</script>

<template>
  <div class="overflow-x-auto border-t border-border">
    <div
      class="grid h-[34px] w-max min-w-full items-center whitespace-nowrap border-b border-border bg-muted text-[11.5px] font-medium text-muted-foreground"
      :style="{ gridTemplateColumns: template }"
    >
      <div class="sticky left-0 z-[2] flex h-full items-center gap-2 border-r border-border bg-muted pl-2 pr-3">
        <span class="w-12" title="Tick rows to compose the preset">Preset</span>
        <button type="button" class="w-[22px] whitespace-nowrap text-right hover:text-foreground" title="Position in the preset, then rank by score" @click="sortBy(model.slug, 'rank')">#{{ indicator("rank") }}</button>
        <span>Provider · endpoint</span>
      </div>
      <template v-for="h in HEADERS" :key="h.label">
        <button v-if="h.key" type="button" :title="h.title" :class="cn('px-2.5 text-left hover:text-foreground', h.align)" @click="sortBy(model.slug, h.key)">{{ h.label }}{{ indicator(h.key) }}</button>
        <div v-else :class="cn('px-2.5', h.align)">{{ h.label }}</div>
      </template>
      <div v-if="columns.brk" class="grid grid-cols-3 gap-2 px-2.5 text-right"><span>Price</span><span>Speed</span><span>Rel.</span></div>
      <button type="button" class="px-2.5 text-left hover:text-foreground" @click="sortBy(model.slug, 'overall')">Overall{{ indicator("overall") }}</button>
      <div class="px-2.5">Verdict</div>
      <div class="px-2.5">Global ban</div>
    </div>
    <EndpointRow
      v-for="r in rows"
      :key="r.id"
      :row="r.e"
      :position="r.position"
      :model="model"
      :cols="columns"
      :template="template"
      :height="height"
      :open="openRows.has(rowKey(r.id))"
      :history="history"
      :preset="preset"
      @toggle="toggle(r.id)"
    />
  </div>
</template>
