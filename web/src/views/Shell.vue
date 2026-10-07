<script setup lang="ts" vapor>
import { computed } from "vue";
import ConnectKey from "@/components/shell/ConnectKey.vue";
import FilterBar from "@/components/shell/FilterBar.vue";
import HeaderBar from "@/components/shell/HeaderBar.vue";
import SettingsSheet from "@/components/settings/SettingsSheet.vue";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SCENARIOS, filters } from "@/stores/filters";
import { go, tab, TABS } from "@/stores/nav";
import { hasData, loading, loadError, overview, presets, providers, refreshNow, status } from "@/stores/data";
import { settingsOpen } from "@/stores/ui";
import ModelsTab from "@/views/ModelsTab.vue";
import PresetsTab from "@/views/PresetsTab.vue";
import ProvidersTab from "@/views/ProvidersTab.vue";

const noKey = computed(() => status.value !== null && status.value.health === "no-key");
const ready = computed(() => overview.value !== null);
const unreachable = computed(() => status.value?.health === "unreachable");
const invalidKey = computed(() => status.value?.health === "invalid-key");
const lastGood = computed(() => ago(status.value?.takenAt));
const errorText = computed(() => status.value?.lastError?.message ?? loadError.value ?? "");

const counts = computed(() => ({
  models: overview.value?.models.length ?? 0,
  providers: providers.value?.rows.length ?? 0,
  presets: presets.value?.length ?? 0,
}));
const pendingBans = computed(() => (providers.value?.pending.added.length ?? 0) + (providers.value?.pending.removed.length ?? 0) > 0);

const context = computed(() => {
  const f = filters.value;
  const scenario = SCENARIOS.find((s) => s.value === f.scenario)?.label.replace("…", "") ?? f.scenario;
  const volume = f.scenario === "actual" ? "real volume" : `${f.volumeM}M input / day`;
  return `${scenario} · ${volume} · ${f.days} days · ${f.minQuant}+ · uptime ≥ ${f.minUptime}%`;
});

const tabLabel = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const alertBox = "flex items-start gap-3 rounded-[10px] border border-bad bg-bad-bg px-4 py-3 text-bad";
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <HeaderBar />
    <ConnectKey v-if="noKey" />
    <template v-else>
      <FilterBar />
      <main class="mx-auto flex max-w-[1680px] flex-col gap-4 px-5 pb-[72px] pt-4">
        <div v-if="unreachable" role="alert" :class="alertBox">
          <svg class="mt-0.5 size-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 8v4M12 16h.01"></path>
          </svg>
          <div class="flex-1">
            <div class="text-[13.5px] font-semibold">OpenRouter unreachable</div>
            <div class="text-[13px] text-foreground/85">{{ errorText }} Showing last good data from {{ lastGood }}.</div>
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
            <div class="text-[13px] text-foreground/85">OpenRouter returned 401: the key was revoked or expired. Showing data from {{ lastGood }}; writes are disabled.</div>
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
          <div class="text-[12.5px] text-muted-foreground">{{ context }}</div>
        </div>
        <template v-if="!ready || (loading && !hasData)">
          <div class="grid grid-cols-4 gap-3">
            <div v-for="n in 4" :key="n" class="flex h-28 flex-col gap-3 rounded-xl border border-border p-4">
              <div class="h-3 w-[45%] animate-pulse rounded-md bg-muted"></div>
              <div class="h-[26px] w-[60%] animate-pulse rounded-md bg-muted"></div>
              <div class="h-2.5 w-[80%] animate-pulse rounded-md bg-muted"></div>
            </div>
          </div>
          <div class="flex flex-col gap-3 rounded-xl border border-border p-4">
            <div class="h-4 w-60 animate-pulse rounded-md bg-muted"></div>
            <div v-for="n in 6" :key="n" class="h-3.5 animate-pulse rounded-md bg-muted"></div>
          </div>
        </template>
        <template v-else>
          <ModelsTab v-if="tab === 'models'" />
          <ProvidersTab v-else-if="tab === 'providers'" />
          <PresetsTab v-else />
        </template>
      </main>
    </template>
    <SettingsSheet />
  </div>
</template>
