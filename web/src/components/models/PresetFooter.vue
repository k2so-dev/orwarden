<script setup lang="ts" vapor>
import { computed, ref } from "vue";
import Toggle from "@/components/app/Toggle.vue";
import type { PresetView } from "@/lib/api";
import { signedMoney, signedPct } from "@/lib/format";
import { PRESET_SLUG_RE, patchPreset, renamePreset, resetPick, syncBusy, syncLabel, syncOne } from "@/lib/presetActions";
import { cn } from "@/lib/utils";
import { dryRun, settings, writeBlocked } from "@/stores/data";

const props = defineProps<{ preset: PresetView }>();

const topN = computed(() => settings.value?.presets.topN ?? 5);
const premium = computed(() => settings.value?.presets.maxPremium ?? 0.15);
const blocked = computed(() => props.preset.status === "empty");
const jsonOpen = ref(false);
const json = computed(() => JSON.stringify(props.preset.config, null, 2));
const min = computed(() => props.preset.policy.minQuantization);
const line = computed(() => {
  const p = props.preset;
  const parts = [
    `${p.ranked.length} endpoint${p.ranked.length === 1 ? "" : "s"}`,
    p.picked ? "ticked endpoints" : p.rankBy === "cost" ? "cheapest effective" : "top by score",
    ...(p.picked ? [] : [`within +${Math.round(premium.value * 100)}% of cheapest`]),
    "no fixed order (cache-friendly)",
    ...(p.policy.fallbacks ? ["fallbacks within list"] : []),
    ...(min.value && p.policy.quantizations.length > 0 ? [`${min.value}+ only`] : []),
    ...(p.policy.zdr ? ["ZDR"] : []),
    ...(p.policy.tools ? ["tools"] : []),
  ];
  return parts.join(" · ");
});
const saving = computed(() => {
  const c = props.preset.cost;
  if (c.saving === null) return "";
  return `${signedMoney(c.saving)} / ${props.preset.horizonDays}d (${signedPct(c.savingPct)}) vs default`;
});
const savingTone = computed(() => ((props.preset.cost.saving ?? 0) <= 0 ? "text-ok" : "text-bad"));
const primary = computed(() => !(props.preset.status === "up-to-date" && !dryRun.value && props.preset.syncedAt));

const renaming = ref(false);
const draft = ref("");
const valid = computed(() => PRESET_SLUG_RE.test(draft.value.trim()));

function startRename() {
  draft.value = props.preset.slug;
  renaming.value = true;
}

async function saveRename() {
  if (!valid.value) return;
  if (await renamePreset(props.preset, draft.value.trim())) renaming.value = false;
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2.5 py-2.5 pl-4 pr-3">
      <div class="flex min-w-0 flex-col gap-0.5">
        <div class="flex flex-wrap items-center gap-2 text-[13px]">
          <span class="font-semibold">Preset</span>
          <code class="select-all font-mono text-xs text-muted-foreground">{{ preset.presetId }}</code>
          <span v-if="preset.picked" class="inline-flex h-[18px] items-center rounded-[5px] bg-muted px-1.5 text-[11px] font-medium">hand-picked</span>
        </div>
        <div v-if="blocked" class="text-xs text-bad"><b class="font-semibold">{{ preset.blocker?.title ?? "No eligible provider." }}</b> {{ preset.blocker?.text ?? "No endpoint passes the filters, so this preset cannot be built." }}</div>
        <div v-else class="text-xs text-muted-foreground">{{ line }}</div>
      </div>
      <span v-if="saving && !blocked" :class="['tnum text-[12.5px] font-semibold', savingTone]">{{ saving }}</span>
      <div class="ml-auto flex flex-wrap items-center gap-1.5">
        <button v-if="preset.picked" type="button" class="inline-flex h-[30px] items-center rounded-lg px-3 text-[12.5px] font-medium hover:bg-accent" @click="resetPick(preset.model)">Reset to top {{ topN }}</button>
        <div class="flex items-center gap-1.5 px-1.5" :title="dryRun ? 'Dry-run is on: scheduled refreshes only plan the write' : 'Scheduled refreshes rewrite this preset whenever its ranking changes'">
          <Toggle :model-value="preset.autoSync" label="Auto-sync" @update:model-value="patchPreset(preset.model, { autoSync: $event })" />
          <span class="text-[12.5px]">Auto-sync</span>
        </div>
                <button v-if="!blocked" type="button" class="inline-flex h-[30px] items-center gap-1 rounded-lg px-3 text-[12.5px] font-medium hover:bg-accent" @click="jsonOpen = !jsonOpen">
          JSON
          <svg :class="cn('size-[13px] transition-transform', jsonOpen && 'rotate-180')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"></path></svg>
        </button>
        <button v-if="blocked" type="button" disabled class="h-[30px] cursor-not-allowed rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground opacity-40">Cannot build</button>
        <button
          v-else
          type="button"
          :disabled="syncBusy || (!dryRun && writeBlocked !== null)"
          :title="!dryRun && writeBlocked ? writeBlocked : undefined"
          :class="cn('inline-flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium disabled:cursor-wait disabled:opacity-70', primary ? 'bg-primary text-primary-foreground' : 'border border-border bg-background')"
          @click="syncOne(preset, () => (jsonOpen = true))"
        >
          {{ syncLabel(preset) }}
        </button>
      </div>
    </div>
    <form v-if="renaming" class="flex items-center gap-2 px-4 pb-3" @submit.prevent="saveRename">
      <span class="font-mono text-[13px] text-muted-foreground">@preset/</span>
      <input
        v-model="draft"
        :class="cn('h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 font-mono text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', valid ? 'border-border' : 'border-bad')"
        spellcheck="false"
        @keydown.esc="renaming = false"
      />
      <button type="submit" :disabled="!valid" class="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground disabled:opacity-40">Save</button>
      <button type="button" class="inline-flex h-8 items-center rounded-lg border border-border px-3 text-[12.5px] font-medium hover:bg-accent" @click="renaming = false">Cancel</button>
    </form>
    <div v-if="renaming && !valid" class="px-4 pb-3 text-xs text-bad">Lowercase letters, digits and hyphens, 2–63 characters.</div>
    <div v-if="jsonOpen" class="border-t border-border bg-muted">
      <pre class="max-h-[280px] overflow-auto px-4 py-3 font-mono text-[11.5px] leading-[1.55]">{{ json }}</pre>
      <div class="flex justify-end px-3 pb-2.5"><button type="button" class="text-xs text-muted-foreground underline underline-offset-[3px] hover:text-foreground" @click="startRename">Rename preset</button></div>
    </div>
  </div>
</template>
