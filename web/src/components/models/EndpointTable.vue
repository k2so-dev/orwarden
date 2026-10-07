<script setup lang="ts" vapor>
import { computed } from "vue";
import type { EndpointView, ModelView } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ensureHistory, historyCache } from "@/stores/data";
import { columns, density, openRows, sortBy, sortState, toggleIn } from "@/stores/ui";
import EndpointRow from "./EndpointRow.vue";

const props = defineProps<{ model: ModelView; horizonLabel: string }>();

type SortKey = "rank" | "in" | "out" | "cache" | "disc" | "om" | "up" | "tps" | "lat" | "share" | "perM" | "hz" | "vs" | "overall";

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
};

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
  const parts = ["236px", "76px"];
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

function toggle(tag: string): void {
  const key = `${props.model.slug}|${tag}`;
  toggleIn(openRows, key);
  void ensureHistory(props.model.slug);
}

const HEADERS = computed(() => {
  const c = columns.value;
  const h: { key: SortKey | null; label: string; align: string }[] = [{ key: null, label: "Quant", align: "" }];
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
    { key: "perM", label: "$ / 1M in", align: "text-right" },
    { key: "hz", label: `$ / ${props.horizonLabel}`, align: "text-right" },
    { key: "vs", label: "vs best", align: "text-right" },
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
      <div class="sticky left-0 z-[2] flex h-full items-center gap-2.5 border-r border-border bg-muted px-3">
        <span class="w-[52px] cursor-pointer text-right hover:text-foreground" @click="sortBy('rank')">#{{ indicator("rank") }}</span>
        <span>Provider · endpoint</span>
      </div>
      <div
        v-for="h in HEADERS"
        :key="h.label"
        :class="cn('px-2.5', h.align, h.key && 'cursor-pointer hover:text-foreground')"
        @click="h.key && sortBy(h.key)"
      >
        {{ h.label }}{{ indicator(h.key) }}
      </div>
      <div v-if="columns.brk" class="grid grid-cols-3 gap-2 px-2.5 text-right"><span>Price</span><span>Speed</span><span>Rel.</span></div>
      <div class="cursor-pointer px-2.5 hover:text-foreground" @click="sortBy('overall')">Overall{{ indicator("overall") }}</div>
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
      :open="openRows.has(model.slug + '|' + r.e.tag)"
      :history="history"
      @toggle="toggle(r.e.tag)"
    />
  </div>
</template>
