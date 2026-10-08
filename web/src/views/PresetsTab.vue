<script setup lang="ts" vapor>
import { computed, ref } from "vue";
import DeltaChip from "@/components/app/DeltaChip.vue";
import PresetCard from "@/components/presets/PresetCard.vue";
import { client, unwrap, type SyncResult } from "@/lib/api";
import { money, periodLabel, signedMoney, volume } from "@/lib/format";
import { act, dryRun, presets, presetsFailed, reloadAfterWrite, settings, writeBlocked } from "@/stores/data";
import { scenarioLabel } from "@/stores/filters";
import { confirmAction } from "@/stores/confirm";
import { notify } from "@/stores/toast";

const list = computed(() => presets.value ?? []);
const busy = ref(false);
const topN = computed(() => settings.value?.presets.topN ?? 5);
const minQuant = computed(() => settings.value?.filters.minQuantization ?? "fp8");
const workload = computed(() => scenarioLabel(settings.value?.presets.defaultScenario ?? "actual"));
const pendingSync = computed(() =>
  list.value.filter(
    (p) =>
      !p.remote?.edits.length &&
      (p.status === "not-created" || p.status === "out-of-date" || (p.status === "up-to-date" && !p.syncedAt)),
  ),
);
const foreign = computed(() =>
  list.value.filter((p) => p.status === "foreign" || p.status === "unknown" || (p.status !== "empty" && p.remote?.edits.length && (p.status !== "up-to-date" || !p.syncedAt))),
);
const SYNC_BATCH = 50;
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
    workload: new Set(priced.map((p) => p.profile.name)).size > 1 ? "mixed workloads" : scenarioLabel(priced[0]!.profile.name),
    volume: priced.every((p) => p.profile.name === "actual" && !p.profile.estimated)
      ? "actual volume"
      : new Set(priced.map((p) => p.profile.inputPerDay)).size === 1
        ? `${volume(priced[0]!.profile.inputPerDay)} in/day`
        : "mixed volume",
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
  const targets = pendingSync.value;
  if (targets.length === 0) {
    notify("Nothing to sync", foreign.value.length > 0 ? `Every other preset matches. Needs a decision on its card: ${foreign.value.map((p) => p.slug).join(", ")}.` : "Every preset already matches the saved ranking.", "info");
    return;
  }
  const names = targets.map((p) => `@preset/${p.slug}`).join("\n");
  if (dryRun.value) {
    notify("Preview only", `Dry-run: ${targets.length} preset(s) would be written: ${targets.map((p) => p.slug).join(", ")}`, "info");
    return;
  }
  const ok = await confirmAction(`Write ${targets.length} preset(s) to OpenRouter?`, `Clients using these ids switch to the new provider lists immediately:\n${names}`, "Write presets");
  if (!ok) return;
  busy.value = true;
  const res: SyncResult[] = [];
  let stopped = false;
  for (let i = 0; i < targets.length; i += SYNC_BATCH) {
    const batch = targets.slice(i, i + SYNC_BATCH);
    const part = await act(() =>
      unwrap(client.presets.sync.$post({ json: { models: batch.map((p) => p.model), dryRun: false, slugs: Object.fromEntries(batch.map((p) => [p.model, p.slug])) } })),
    );
    if (!part) {
      stopped = true;
      break;
    }
    res.push(...part);
  }
  busy.value = false;
  if (stopped) {
    notify("Sync stopped", `${res.filter((r) => r.status === "synced").length} confirmed written · ${targets.length - res.length} unconfirmed (the failed batch may be partly written). Run Sync all again to continue.`, "err");
    await reloadAfterWrite();
    return;
  }
  const failed = res.filter((r) => r.status === "failed");
  if (failed.length > 0) notify(`${failed.length} preset(s) failed`, failed.map((r) => `${r.slug}: ${r.error ?? "unknown error"}`).join(" · "), "err");
  else notify("Presets synced", `${res.filter((r) => r.status === "synced").length} written · ${res.filter((r) => r.status === "skipped").length} skipped${foreign.value.length ? ` · ${foreign.value.length} need a decision on their card` : ""}`);
  await reloadAfterWrite();
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div v-if="presetsFailed && list.length > 0" class="rounded-[10px] border border-bad bg-bad-bg px-4 py-2.5 text-[13px] text-bad">Preset status failed to reload. Statuses below may be stale and copying is disabled until the next successful refresh.</div>
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex min-w-80 flex-1 items-start gap-2.5 rounded-[10px] border border-border px-4 py-3 text-[13px]">
        <svg class="mt-px size-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg>
        <div>
          Paste the preset id as the model name in Cherry Studio, DeepSeek harness or any OpenAI-compatible client.
          <span class="text-muted-foreground">Each preset keeps the top {{ topN }} {{ minQuant }}+ endpoints for the {{ workload.toLowerCase() }} workload, ordered {{ order }}. Presets use the saved rules, not the filters above.</span>
        </div>
      </div>
      <button
        type="button"
        :disabled="busy || (!dryRun && writeBlocked !== null)"
        :title="!dryRun && writeBlocked ? writeBlocked : undefined"
        class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-70" @click="syncAll">
        <svg :class="['size-3.5', busy && 'animate-spin']" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><path d="M21 3v5h-5"></path></svg>
        {{ dryRun ? "Preview sync" : pendingSync.length ? `Sync ${pendingSync.length} preset${pendingSync.length === 1 ? "" : "s"}` : "All presets synced" }}
      </button>
    </div>
    <div v-if="totals" class="tnum flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-[10px] border border-border bg-card px-4 py-2.5 text-[13px]">
      <span class="text-muted-foreground">{{ totals.count }} presets · {{ totals.workload }} · {{ totals.volume }} · {{ totals.period }}</span>
      <span>Default routing <b class="font-semibold">{{ totals.def }}</b></span>
      <span class="flex items-center gap-1.5">With presets <b class="font-semibold">{{ totals.pre }}</b><DeltaChip :value="totals.rel" /></span>
      <span :class="['ml-auto font-medium', totals.tone]">{{ totals.month }} / 30 days · {{ totals.year }} / year</span>
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(680px,1fr))] gap-3">
      <PresetCard v-for="p in list" :key="p.model" :preset="p" />
    </div>
  </div>
</template>
