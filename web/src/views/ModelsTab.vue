<script setup lang="ts" vapor>
import { computed, ref, shallowRef, watch } from "vue";
import { refDebounced } from "@vueuse/core";
import { client, unwrap, type CatalogItem } from "@/lib/api";
import { money, pct } from "@/lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import ModelSection from "@/components/models/ModelSection.vue";
import { act, overview, refreshNow, settings } from "@/stores/data";

const models = computed(() => overview.value?.models ?? []);
const summary = computed(() => overview.value?.summary ?? null);
const clean = (v: number | null) => (v === null || Math.abs(v) < 0.005 ? 0 : v);
const saving = computed(() => (summary.value && summary.value.default > 0 ? 1 - summary.value.presets / summary.value.default : null));
const banSaving = computed(() => (summary.value && summary.value.default > 0 ? 1 - summary.value.bans / summary.value.default : null));

async function save(patch: { watchlist?: { slug: string; weightUsd: number }[]; excludedModels?: string[] }) {
  const res = await act(() => unwrap(client.settings.$put({ json: patch })));
  if (res) {
    settings.value = res;
    await refreshNow(false);
  }
}

function removeModel(slug: string) {
  const s = settings.value;
  if (!s) return;
  void save({ watchlist: s.watchlist.filter((w) => w.slug !== slug), excludedModels: [...new Set([...s.excludedModels, slug])] });
}

function addModel(slug: string) {
  const s = settings.value;
  if (!s) return;
  pickerOpen.value = false;
  void save({
    watchlist: s.watchlist.some((w) => w.slug === slug) ? s.watchlist : [...s.watchlist, { slug, weightUsd: 0 }],
    excludedModels: s.excludedModels.filter((m) => m !== slug),
  });
}

const pickerOpen = ref(false);
const term = ref("");
const debounced = refDebounced(term, 200);
const results = shallowRef<CatalogItem[]>([]);
watch(
  [debounced, pickerOpen],
  async ([q, open]) => {
    if (!open) return;
    const items = await act(() => unwrap(client.catalog.$get({ query: { q, limit: "30" } })));
    if (items) results.value = items;
  },
  { immediate: true },
);
const shown = computed(() => {
  const have = new Set(models.value.map((m) => m.slug));
  return results.value.filter((r) => !have.has(r.id));
});

const cards = computed(() => [
  { label: "Cost per period", value: money(summary.value?.default), hint: "default routing" },
  { label: "With bans", value: money(summary.value?.bans), hint: banSaving.value === null ? "" : `${pct(clean(banSaving.value))} saved` },
  { label: "With presets", value: money(summary.value?.presets), hint: saving.value === null ? "" : `${pct(clean(saving.value))} saved` },
  { label: "Spend at risk", value: pct(summary.value?.riskShare), hint: "on bad endpoints" },
]);
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-center gap-2">
      <span
        v-for="m in models"
        :key="m.slug"
        class="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card pl-3 pr-1.5 text-[12.5px]"
      >
        <span class="font-mono">{{ m.slug }}</span>
        <button type="button" class="grid size-5 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground" :aria-label="`Remove ${m.slug}`" @click="removeModel(m.slug)">
          <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
        </button>
      </span>
      <Popover v-model:open="pickerOpen">
        <PopoverTrigger as-child>
          <button type="button" class="inline-flex h-7 items-center gap-1.5 rounded-full border border-dashed border-border px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14M12 5v14"></path></svg>
            Add model
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" class="w-[360px] p-0">
          <Command :filter-function="(list: unknown[]) => list">
            <CommandInput v-model="term" placeholder="Search OpenRouter models" />
            <CommandList>
              <CommandEmpty>No models found.</CommandEmpty>
              <CommandGroup>
                <CommandItem v-for="r in shown" :key="r.id" :value="r.id" class="flex items-center justify-between gap-3" @select="addModel(r.id)">
                  <span class="min-w-0">
                    <span class="block truncate text-[13px]">{{ r.name }}</span>
                    <span class="block truncate font-mono text-[11.5px] text-muted-foreground">{{ r.id }}</span>
                  </span>
                  <span v-if="r.usageUsd > 0" class="tnum flex-none text-xs text-muted-foreground">{{ money(r.usageUsd) }}</span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>

    <div v-if="models.length === 0" class="rounded-xl border border-dashed border-border px-6 py-14 text-center">
      <div class="text-[15px] font-semibold">No models selected</div>
      <div class="mt-1 text-[13px] text-muted-foreground">Add a model to compare its provider endpoints.</div>
    </div>

    <template v-else>
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div v-for="c in cards" :key="c.label" class="rounded-xl border border-border bg-card px-4 py-3">
          <div class="text-xs text-muted-foreground">{{ c.label }}</div>
          <div class="tnum mt-1 text-[22px] font-semibold leading-none">{{ c.value }}</div>
          <div class="mt-1.5 h-4 text-xs text-muted-foreground">{{ c.hint }}</div>
        </div>
      </div>
      <ModelSection v-for="m in models" :key="m.slug" :model="m" />
    </template>
  </div>
</template>
