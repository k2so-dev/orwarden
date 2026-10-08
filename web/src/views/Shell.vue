<script setup lang="ts" vapor>
import { computed } from "vue";
import ConnectKey from "@/components/shell/ConnectKey.vue";
import WorkloadBar from "@/components/shell/WorkloadBar.vue";
import HeaderBar from "@/components/shell/HeaderBar.vue";
import SettingsSheet from "@/components/settings/SettingsSheet.vue";
import { ago, periodLabel } from "@/lib/format";
import { clock } from "@/stores/ui";
import { cn } from "@/lib/utils";
import { localView } from "@/stores/filters";
import { view, workloadLabel } from "@/stores/workload";
import { pendingSync, presetSummary, syncAll, syncBusy } from "@/lib/presetActions";
import { go, tab, TABS } from "@/stores/nav";
import { dryRun, hasData, loading, loadError, overview, presetsFailed, providers, refreshing, refreshNow, status, writeBlocked } from "@/stores/data";
import { settingsOpen } from "@/stores/ui";
import ModelsTab from "@/views/ModelsTab.vue";
import ProvidersTab from "@/views/ProvidersTab.vue";

const noKey = computed(() => status.value !== null && status.value.health === "no-key");
const ready = computed(() => overview.value !== null);
const unreachable = computed(() => status.value?.health === "unreachable");
const invalidKey = computed(() => status.value?.health === "invalid-key");
const lastGood = computed(() => ago(status.value?.takenAt, clock.value.getTime()));
const errorText = computed(() => status.value?.lastError?.message ?? loadError.value ?? "OpenRouter did not respond.");
const skeleton = computed(() => loading.value && !ready.value);
const noData = computed(() => !skeleton.value && !ready.value);

const counts = computed(() => ({
  models: overview.value?.models.length ?? 0,
  providers: providers.value?.rows.length ?? 0,
}));
const pendingBans = computed(() => (providers.value?.pending.added.length ?? 0) + (providers.value?.pending.removed.length ?? 0) > 0);

const context = computed(() => {
  const v = view.value;
  const volume = v.actual ? "actual volume" : `${v.volumeM}M input / day`;
  return `${workloadLabel()} · ${volume} · ${periodLabel(localView.value.days)} · ${v.minQuant}+ · uptime ≥ ${v.minUptime}%${v.zdrOnly ? " · ZDR only" : ""}`;
});

const tabLabel = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const alertBox = "flex items-start gap-3 rounded-[10px] border border-bad bg-bad-bg px-4 py-3 text-bad";
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <HeaderBar />
    <ConnectKey v-if="noKey" />
    <template v-else>
      <WorkloadBar />
      <main class="mx-auto flex max-w-[1840px] flex-col gap-4 px-5 pb-[72px] pt-4">
        <div v-if="unreachable" role="alert" :class="alertBox">
          <svg class="mt-0.5 size-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 8v4M12 16h.01"></path>
          </svg>
          <div class="flex-1">
            <div class="text-[13.5px] font-semibold">OpenRouter unreachable</div>
            <div class="text-[13px] text-foreground/85">{{ errorText.replace(/\.?$/, ".") }} Showing last good data from {{ lastGood }} — writes are disabled until it recovers.</div>
          </div>
          <button type="button" class="h-[30px] rounded-lg border border-border bg-background px-3 text-[13px] font-medium text-foreground" @click="refreshNow(false)">Retry</button>
        </div>
        <div v-if="invalidKey" role="alert" :class="alertBox">
          <svg class="mt-0.5 size-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 8v4M12 16h.01"></path>
          </svg>
          <div class="flex-1">
            <div class="text-[13.5px] font-semibold">Management key rejected</div>
            <div class="text-[13px] text-foreground/85">OpenRouter returned 401 — the key was revoked or expired. Showing data from {{ lastGood }}; writes are disabled until the key is replaced.</div>
          </div>
          <button type="button" class="h-[30px] rounded-lg bg-primary px-3 text-[13px] font-medium text-primary-foreground" @click="settingsOpen = true">Replace key</button>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex gap-[2px] rounded-[10px] bg-muted p-[3px]">
            <button
              v-for="t in TABS"
              :key="t"
              type="button"
              :class="
                cn(
                  'inline-flex h-[30px] items-center gap-[7px] rounded-[7px] px-3 text-[13px] font-medium',
                  tab === t ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )
              "
              @click="go(t)"
            >
              {{ tabLabel(t) }}
              <span class="tnum text-[11px] text-muted-foreground">{{ counts[t] }}</span>
              <span v-if="t === 'providers' && pendingBans" class="size-1.5 rounded-full bg-warn"></span>
            </button>
          </div>
          <div v-if="tab === 'models' && ready" class="flex items-center gap-3">
            <span class="text-[12.5px] text-muted-foreground">{{ presetsFailed ? "Preset status unavailable" : presetSummary }}</span>
            <button
              type="button"
              :disabled="syncBusy || (!dryRun && writeBlocked !== null)"
              :title="!dryRun && writeBlocked ? writeBlocked : undefined"
              class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium hover:bg-accent disabled:cursor-wait disabled:opacity-60"
              @click="syncAll"
            >
              <svg :class="['size-3.5', syncBusy && 'animate-spin']" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><path d="M21 3v5h-5"></path></svg>
              {{ dryRun ? "Preview sync" : pendingSync.length ? `Sync ${pendingSync.length} preset${pendingSync.length === 1 ? "" : "s"}` : "All presets synced" }}
            </button>
          </div>
          <div v-else class="text-[12.5px] text-muted-foreground">{{ context }}</div>
        </div>
        <template v-if="skeleton">
          <div class="grid grid-cols-4 gap-3">
            <div v-for="n in 4" :key="n" class="flex h-28 flex-col gap-3 rounded-xl border border-border p-4">
              <div class="h-3 w-[45%] animate-pulse rounded-md bg-muted"></div>
              <div class="h-[26px] w-[60%] animate-pulse rounded-md bg-muted"></div>
              <div class="h-2.5 w-[80%] animate-pulse rounded-md bg-muted"></div>
            </div>
          </div>
          <div class="flex flex-col gap-3 rounded-xl border border-border p-4">
            <div class="h-4 w-60 animate-pulse rounded-md bg-muted"></div>
            <div v-for="n in 8" :key="n" class="grid grid-cols-[200px_60px_repeat(8,1fr)] gap-3">
              <div v-for="c in 10" :key="c" class="h-3.5 animate-pulse rounded-md bg-muted"></div>
            </div>
          </div>
        </template>
        <div v-else-if="noData" class="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border px-6 py-12 text-center">
          <div class="text-[15px] font-semibold">{{ hasData ? "Data could not be loaded" : "No data yet" }}</div>
          <div class="max-w-[440px] text-[13.5px] text-muted-foreground">{{ hasData ? errorText : "Run the first refresh to read providers, prices and your traffic from OpenRouter." }}</div>
          <button type="button" :disabled="refreshing" class="mt-1.5 h-[34px] rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:cursor-wait disabled:opacity-70" @click="refreshNow(false)">{{ refreshing ? "Refreshing…" : "Refresh now" }}</button>
        </div>
        <template v-else>
          <ModelsTab v-if="tab === 'models'" />
          <ProvidersTab v-else />
        </template>
      </main>
    </template>
    <SettingsSheet />
  </div>
</template>
