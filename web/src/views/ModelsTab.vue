<script setup lang="ts" vapor>
import { computed, ref, shallowRef, watch } from "vue";
import { refDebounced, until } from "@vueuse/core";
import { client, unwrap, type CatalogItem } from "@/lib/api";
import { money, pct, periodLabel } from "@/lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import DeltaChip from "@/components/app/DeltaChip.vue";
import Tip from "@/components/app/Tip.vue";
import ModelSection from "@/components/models/ModelSection.vue";
import { filters, scenarioLabel, viewQuery } from "@/stores/filters";
import { act, overview, providers, refreshing, refreshNow, settings } from "@/stores/data";
import { notify } from "@/stores/toast";

const models = computed(() => overview.value?.models ?? []);
const openByDefault = computed(() => new Set([...models.value].sort((a, b) => b.usageUsd - a.usageUsd || a.slug.localeCompare(b.slug)).slice(0, 2).map((m) => m.slug)));
const summary = computed(() => overview.value?.summary ?? null);
const selected = computed(() => new Set(models.value.map((m) => m.slug)));
const horizon = computed(() => periodLabel(overview.value?.horizonDays ?? filters.value.days));
const scenarioName = computed(() => scenarioLabel(filters.value.scenario));
const usageDays = computed(() => overview.value?.usageDays ?? settings.value?.usageWindowDays ?? 7);
const saving = ref(false);
const busy = computed(() => saving.value || refreshing.value);
const delta = (v: number | undefined, base: number | undefined) => (base && v !== undefined ? v / base - 1 : null);
const banCount = computed(() => `${providers.value?.pending.desired.length ?? 0} providers ignored (incl. draft)`);
const presetSub = computed(() => {
  const s = summary.value;
  if (!s) return "";
  const noPreset = models.value.filter((m) => m.cost.preset === null).map((m) => m.name);
  const saving = s.default - s.presets;
  return `${saving >= 0 ? "saves" : "costs"} ${money(Math.abs(saving))} ${saving >= 0 ? "vs" : "more than"} default${noPreset.length ? ` · ${noPreset.length === 1 ? noPreset[0] : `${noPreset.length} models`} at ban routing` : ""}`;
});
const defaultTip = [
  { text: "OpenRouter splits traffic across all endpoints by its own load balancing. Shares come from your last 7 days of traffic.", tone: "fg" as const },
];

async function save(patch: { watchlist?: { slug: string; weightUsd: number }[]; excludedModels?: string[] }): Promise<"failed" | "saved" | "refreshed"> {
  saving.value = true;
  try {
    const res = await act(() => unwrap(client.settings.$put({ json: patch })));
    if (!res) return "failed";
    settings.value = res;
    return (await refreshNow(false)) ? "refreshed" : "saved";
  } finally {
    saving.value = false;
  }
}

async function removeModel(slug: string) {
  const s = settings.value;
  if (!s || busy.value) return;
  const name = models.value.find((m) => m.slug === slug)?.name ?? slug;
  const previous = { watchlist: s.watchlist, excludedModels: s.excludedModels };
  const ok = (await save({ watchlist: s.watchlist.filter((w) => w.slug !== slug), excludedModels: [...new Set([...s.excludedModels, slug])] })) !== "failed";
  if (ok) notify("Model removed", `${name} is no longer tracked`, "ok", { label: "Undo", run: () => void undoRemove(slug, previous) });
}

async function undoRemove(slug: string, previous: { watchlist: { slug: string; weightUsd: number }[]; excludedModels: string[] }) {
  await until(busy).toBe(false);
  const s = settings.value;
  if (!s) return;
  const entry = previous.watchlist.find((w) => w.slug === slug);
  await save({
    watchlist: entry && !s.watchlist.some((w) => w.slug === slug) ? [...s.watchlist, entry] : s.watchlist,
    excludedModels: previous.excludedModels.includes(slug) ? s.excludedModels : s.excludedModels.filter((m) => m !== slug),
  });
}

async function addModel(slug: string) {
  const s = settings.value;
  if (!s || busy.value) return;
  const result = await save({
    watchlist: s.watchlist.some((w) => w.slug === slug) ? s.watchlist : [...s.watchlist, { slug, weightUsd: 0 }],
    excludedModels: s.excludedModels.filter((m) => m !== slug),
  });
  if (result === "saved") notify("Model saved", `${slug} will appear after the next successful refresh`, "info");
  if (result !== "refreshed" || selected.value.has(slug) || !settings.value) return;
  const fresh = await act(() => unwrap(client.overview.$get({ query: viewQuery.value })));
  if (!fresh || fresh.models.some((m) => m.slug === slug) || !settings.value) return;
  notify("Model not added", `OpenRouter lists no endpoints for ${slug}`, "err");
  const res = await act(() => unwrap(client.settings.$put({ json: { watchlist: settings.value!.watchlist.filter((w) => w.slug !== slug) } })));
  if (res) settings.value = res;
}

function pick(slug: string) {
  if (selected.value.has(slug)) void removeModel(slug);
  else void addModel(slug);
}

const pickerOpen = ref(false);
const term = ref("");
const debounced = refDebounced(term, 200);
const results = shallowRef<CatalogItem[]>([]);
watch(
  [debounced, pickerOpen],
  async ([q, open]) => {
    if (!open) return;
    const items = await act(() => unwrap(client.catalog.$get({ query: { q, limit: "40" } })));
    if (items) results.value = items;
  },
  { immediate: true },
);
const shown = computed(() =>
  [...results.value].sort((a, b) => Number(selected.value.has(b.id)) - Number(selected.value.has(a.id))),
);

const card = "flex flex-col gap-1.5 rounded-xl border border-border bg-card p-4";
const cardLabel = "text-[12.5px] font-medium text-muted-foreground";
const cardValue = "tnum text-[26px] font-semibold tracking-[-0.02em]";
const cardSub = "text-pretty text-[12.5px] text-muted-foreground";
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
      <span class="mr-1 text-xs font-medium text-muted-foreground">Models</span>
      <span v-for="m in models" :key="m.slug" class="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-muted pl-2.5 pr-1 text-[12.5px]" :title="m.slug">
        <span class="font-medium">{{ m.name }}</span>
        <span class="tnum text-muted-foreground">{{ money(m.usageUsd) }} / {{ usageDays }}d</span>
        <button type="button" :title="`Stop tracking ${m.name}`" :disabled="busy" class="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-border disabled:opacity-40" @click="removeModel(m.slug)">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
        </button>
      </span>
      <Popover v-model:open="pickerOpen">
        <PopoverTrigger class="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 text-[12.5px] font-medium hover:bg-accent">
            <svg class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M12 5v14"></path></svg>
            Add model
          </PopoverTrigger>
        <PopoverContent align="start" class="w-[380px] overflow-hidden p-0">
          <div class="flex items-center gap-2 border-b border-border px-3">
            <svg class="size-3.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="8"></circle><path d="m21 21-4.3-4.3"></path></svg>
            <input v-model="term" placeholder="Search OpenRouter catalog…" class="h-10 flex-1 bg-transparent text-[13px] outline-none" />
          </div>
          <div class="max-h-[280px] overflow-y-auto p-1">
            <div class="flex items-center justify-between px-2 py-1.5 text-[11.5px] font-medium text-muted-foreground">
              <span>Tracked first, then by traffic in the last {{ usageDays }} days</span>
              <svg v-if="busy" class="size-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
            </div>
            <div v-if="shown.length === 0" class="px-2 py-3 text-[13px] text-muted-foreground">No models found.</div>
            <button
              v-for="r in shown"
              :key="r.id"
              type="button"
              :disabled="busy"
              class="flex w-full items-center gap-2.5 rounded-md px-2 py-[7px] text-left text-[13px] hover:bg-accent disabled:cursor-wait disabled:opacity-60"
              :title="r.name"
              @click="pick(r.id)"
            >
              <span :class="['grid size-4 flex-none place-items-center rounded border', selected.has(r.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border']">
                <svg v-if="selected.has(r.id)" class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M20 6 9 17l-5-5"></path></svg>
              </span>
              <span class="min-w-0 flex-1 truncate font-mono text-[12.5px]">{{ r.id }}</span>
              <span class="tnum flex-none text-xs text-muted-foreground">{{ r.usageUsd > 0 ? `${money(r.usageUsd)} / ${usageDays}d` : "no traffic" }}</span>
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <span class="ml-auto text-xs text-muted-foreground">Pre-selected: models with traffic in the last {{ usageDays }} days</span>
    </div>

    <div v-if="models.length === 0" class="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border px-6 py-12 text-center">
      <div class="text-[15px] font-semibold">No models tracked</div>
      <div class="max-w-[440px] text-pretty text-[13.5px] text-muted-foreground">
        No model had traffic in the last {{ usageDays }} days or all of them were removed. Pick the models you plan to use to see providers, savings and presets.
      </div>
      <button type="button" class="mt-1.5 h-[34px] rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground" @click="pickerOpen = true">Pick models</button>
    </div>

    <template v-else>
      <div class="grid grid-cols-4 gap-3">
        <div :class="card">
          <Tip title="Default routing" :lines="defaultTip" :class="cardLabel">Default routing<svg class="ml-1 size-3 self-center" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg></Tip>
          <div class="flex items-baseline gap-1.5"><span :class="cardValue">{{ money(summary?.default) }}</span><span class="text-[13px] text-muted-foreground">/ {{ horizon }}</span></div>
          <div :class="cardSub">What you pay now · {{ scenarioName }}</div>
        </div>
        <div :class="card">
          <div :class="cardLabel">With global bans</div>
          <div class="flex items-baseline gap-2"><span :class="cardValue">{{ money(summary?.bans) }}</span><DeltaChip :value="delta(summary?.bans, summary?.default)" class="h-5 rounded-md px-[7px] text-[11.5px]" /></div>
          <div :class="cardSub">{{ banCount }}</div>
        </div>
        <div :class="card">
          <div :class="cardLabel">With saved presets</div>
          <div class="flex items-baseline gap-2"><span :class="cardValue">{{ money(summary?.presets) }}</span><DeltaChip :value="delta(summary?.presets, summary?.default)" class="h-5 rounded-md px-[7px] text-[11.5px]" /></div>
          <div :class="cardSub">{{ presetSub }}</div>
        </div>
        <div :class="card">
          <div :class="cardLabel">Risk: low or unknown quantization</div>
          <div class="flex items-baseline gap-1.5"><span :class="[cardValue, 'text-bad']">{{ pct(summary?.riskShare) }}</span><span class="text-[13px] text-muted-foreground">of traffic</span></div>
          <div class="mt-0.5 h-1.5 rounded-full bg-muted"><div class="h-1.5 rounded-full bg-bad" :style="{ width: pct(summary?.riskShare) }"></div></div>
          <div :class="cardSub">Under default routing, volume-weighted · open-weight models only</div>
        </div>
      </div>
      <ModelSection v-for="m in models" :key="m.slug" :model="m" :default-open="openByDefault.has(m.slug)" />
    </template>
  </div>
</template>
