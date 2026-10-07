<script setup lang="ts" vapor>
import { computed, ref } from "vue";
import DeltaChip from "@/components/app/DeltaChip.vue";
import PresetCard from "@/components/presets/PresetCard.vue";
import { client, unwrap } from "@/lib/api";
import { money, periodLabel, signedMoney } from "@/lib/format";
import { act, dryRun, presets, previewOnly, reloadAfterWrite, settings } from "@/stores/data";
import { filters, scenarioLabel, viewQuery } from "@/stores/filters";
import { notify } from "@/stores/toast";

const list = computed(() => presets.value ?? []);
const busy = ref(false);
const topN = computed(() => settings.value?.presets.topN ?? 5);
const order = computed(() => (settings.value?.presets.rankBy === "cost" ? "from cheapest to most expensive effective price" : "by weighted score, best first"));

const totals = computed(() => {
  const priced = list.value.filter((p) => p.cost.default !== null && p.cost.preset !== null);
  if (priced.length === 0) return null;
  const days = priced[0]!.horizonDays;
  const def = priced.reduce((a, p) => a + p.cost.default!, 0);
  const pre = priced.reduce((a, p) => a + p.cost.preset!, 0);
  const delta = pre - def;
  return {
    count: priced.length,
    period: periodLabel(days),
    def: money(def),
    pre: money(pre),
    rel: def > 0 ? pre / def - 1 : null,
    month: signedMoney((delta * 30) / days),
    year: signedMoney((delta * 365) / days),
    tone: Math.abs(delta) < 0.005 ? "text-muted-foreground" : delta < 0 ? "text-ok" : "text-bad",
  };
});

async function syncAll() {
  busy.value = true;
  const models = list.value.filter((p) => p.status !== "empty").map((p) => p.model);
  const res = models.length ? await act(() => unwrap(client.presets.sync.$post({ json: { models, view: viewQuery.value, dryRun: dryRun.value } }))) : [];
  busy.value = false;
  if (!res) return;
  const failed = res.filter((r) => r.status === "failed");
  if (failed.length > 0) notify("Write failed", `${failed.length} preset(s): ${failed[0]!.error ?? ""}`, "err");
  else if (dryRun.value) previewOnly();
  else notify("Presets synced", `${res.filter((r) => r.status === "synced").length} written · ${res.filter((r) => r.status === "skipped").length} skipped`);
  await reloadAfterWrite();
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex min-w-80 flex-1 items-start gap-2.5 rounded-[10px] border border-border px-4 py-3 text-[13px]">
        <svg class="mt-px size-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg>
        <div>
          Paste the preset id as the model name in Cherry Studio, DeepSeek harness or any OpenAI-compatible client.
          <span class="text-muted-foreground">Each preset keeps the top {{ topN }} {{ filters.minQuant }}+ endpoints, ordered {{ order }}.</span>
        </div>
      </div>
      <button type="button" :disabled="busy" class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:opacity-50" @click="syncAll">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><path d="M21 3v5h-5"></path></svg>
        {{ dryRun ? "Preview all" : "Sync all presets" }}
      </button>
    </div>
    <div v-if="totals" class="tnum flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-[10px] border border-border bg-card px-4 py-2.5 text-[13px]">
      <span class="text-muted-foreground">{{ totals.count }} presets · {{ scenarioLabel(filters.scenario) }} · {{ totals.period }}</span>
      <span>Default routing <b class="font-semibold">{{ totals.def }}</b></span>
      <span class="flex items-center gap-1.5">With presets <b class="font-semibold">{{ totals.pre }}</b><DeltaChip :value="totals.rel" /></span>
      <span :class="['ml-auto font-medium', totals.tone]">{{ totals.month }} / 30 days · {{ totals.year }} / year</span>
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(680px,1fr))] gap-3">
      <PresetCard v-for="p in list" :key="p.model" :preset="p" />
    </div>
  </div>
</template>
