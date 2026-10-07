<script setup lang="ts" vapor>
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import Toggle from "@/components/app/Toggle.vue";
import { client, unwrap, type PresetView } from "@/lib/api";
import { copy } from "@/lib/clipboard";
import { money, pct, price, uptime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { act, dryRun, reloadAfterWrite } from "@/stores/data";
import { filters } from "@/stores/filters";

const props = defineProps<{ preset: PresetView }>();

const STATUS: Record<PresetView["status"], { kind: BadgeKind; text: string }> = {
  "up-to-date": { kind: "ok", text: "Up to date" },
  "out-of-date": { kind: "warn", text: "Out of date" },
  "not-created": { kind: "mute", text: "Not created" },
  empty: { kind: "bad", text: "Cannot build" },
  unknown: { kind: "mute", text: "Unknown" },
};

const blocked = computed(() => props.preset.status === "empty");
const badge = computed(() => STATUS[props.preset.status]);
const jsonOpen = ref(false);
const json = computed(() => JSON.stringify(props.preset.config, null, 2));
const busy = ref(false);

const policies = computed(() => {
  const p = props.preset.policy;
  return [
    `${filters.value.minQuant}+ only`,
    p.zdr ? "ZDR only" : "ZDR not required",
    p.tools ? "Tools required" : "Tools optional",
    p.fallbacks ? "Fallbacks allowed" : "No fallbacks",
  ];
});

const savingsClass = computed(() => ((props.preset.cost.saving ?? 0) <= 0 ? "text-ok" : "text-warn"));
const savings = computed(() => {
  const c = props.preset.cost;
  if (c.saving === null || c.savingPct === null) return "";
  const cheaper = c.saving <= 0;
  return `${cheaper ? "Saves" : "Costs"} ${money(Math.abs(c.saving))} (${pct(Math.abs(c.savingPct))}) ${cheaper ? "vs" : "more than"} default routing`;
});

const actionLabel = computed(() => {
  const create = props.preset.status === "not-created";
  if (dryRun.value) return create ? "Preview create" : "Preview update";
  return create ? "Create preset" : "Update preset";
});

async function patch(body: { autoSync?: boolean; pinned?: string[] }) {
  const res = await act(() => unwrap(client.presets.settings.$put({ json: { model: props.preset.model, ...body } })));
  if (res) await reloadAfterWrite();
}

function togglePin(tag: string) {
  const pinned = props.preset.pinned;
  void patch({ pinned: pinned.includes(tag) ? pinned.filter((t) => t !== tag) : [...pinned, tag] });
}

async function sync() {
  busy.value = true;
  const res = await act(() => unwrap(client.presets.sync.$post({ json: { models: [props.preset.model], dryRun: dryRun.value } })));
  busy.value = false;
  const r = res?.[0];
  if (!r) return;
  if (r.status === "failed") toast.error(r.error ?? "Sync failed");
  else if (r.status === "planned") toast.info(`Would write ${r.slug}`);
  else toast.success(r.status === "synced" ? `Preset ${r.slug} saved` : `Skipped ${r.slug}`);
  await reloadAfterWrite();
}

const GRID = "grid grid-cols-[28px_22px_minmax(0,1fr)_72px_70px_64px_52px_36px] items-center gap-1.5";
</script>

<template>
  <div class="flex flex-col rounded-xl border border-border bg-card">
    <div class="flex flex-col gap-2.5 px-4 pb-3 pt-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-[15px] font-semibold">{{ preset.name }}</div>
          <div class="text-xs text-muted-foreground">{{ preset.model }} · {{ preset.eligibleCount }} eligible endpoints</div>
        </div>
        <StatusBadge :kind="badge.kind" class="h-[22px] text-[11.5px]">{{ badge.text }}</StatusBadge>
      </div>
      <div class="flex gap-2">
        <div class="flex h-9 flex-1 items-center overflow-hidden whitespace-nowrap rounded-lg border border-border bg-muted px-3 font-mono text-[13px]">{{ preset.presetId }}</div>
        <button type="button" class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground" @click="copy(preset.presetId)">
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
          Copy id
        </button>
      </div>
    </div>

    <div v-if="blocked" class="mx-4 mb-3.5 flex gap-2 rounded-lg bg-bad-bg px-3 py-2.5 text-[13px] text-bad">
      <svg class="mt-px size-[15px] flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4M12 17h.01"></path></svg>
      <span>
        <b class="font-semibold">No eligible provider.</b>
        <span class="text-foreground"> Every endpoint fails the quality filters, so a safe preset cannot be built. Lower min quantization or wait for a new provider.</span>
      </span>
    </div>

    <template v-else>
      <div class="tnum border-t border-border text-[12.5px]">
        <div :class="[GRID, 'h-[30px] border-b border-border px-2.5 text-[11.5px] font-medium text-muted-foreground']">
          <span></span><span>#</span><span>Provider</span><span>Quant</span><span class="text-right">$ / 1M in</span><span class="text-right">Uptime</span><span class="text-right">tok/s</span><span></span>
        </div>
        <div v-for="e in preset.ranked" :key="e.tag" :class="[GRID, 'h-[38px] border-b border-border px-2.5']">
          <span class="grid place-items-center text-muted-foreground">
            <svg class="size-3.5" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="5" r="1.5"></circle><circle cx="9" cy="12" r="1.5"></circle><circle cx="9" cy="19" r="1.5"></circle><circle cx="15" cy="5" r="1.5"></circle><circle cx="15" cy="12" r="1.5"></circle><circle cx="15" cy="19" r="1.5"></circle></svg>
          </span>
          <span class="font-semibold">{{ e.rank }}</span>
          <span class="flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
            <span class="font-medium">{{ e.providerName }}</span>
            <span class="font-mono text-[11px] text-muted-foreground">{{ e.tag }}</span>
          </span>
          <span><StatusBadge kind="ok">{{ e.quantization }}</StatusBadge></span>
          <span class="text-right font-medium">{{ price(e.costPerM) }}</span>
          <span class="text-right">{{ uptime(e.uptime) }}</span>
          <span class="text-right">{{ e.tps === null ? "—" : Math.round(e.tps) }}</span>
          <button
            type="button"
            title="Pin provider"
            :aria-pressed="preset.pinned.includes(e.tag)"
            :class="cn('grid size-7 place-items-center rounded-md', preset.pinned.includes(e.tag) ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent')"
            @click="togglePin(e.tag)"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect width="18" height="11" x="3" y="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          </button>
        </div>
      </div>
      <div class="flex flex-wrap gap-1.5 px-4 pt-3">
        <span v-for="p in policies" :key="p" class="inline-flex h-[22px] items-center rounded-full border border-border px-2 text-[11.5px] font-medium">{{ p }}</span>
      </div>
      <div class="tnum px-4 pb-3.5 pt-2.5 text-[13px] font-medium" :class="savingsClass">{{ savings }}</div>
    </template>

    <div class="mt-auto flex items-center gap-2.5 border-t border-border py-2.5 pl-4 pr-3">
      <Toggle :model-value="preset.autoSync" label="Auto-sync" @update:model-value="patch({ autoSync: $event })" />
      <span class="text-[12.5px]">Auto-sync on refresh</span>
      <div class="ml-auto flex gap-1.5">
        <button v-if="!blocked" type="button" class="inline-flex h-[30px] items-center gap-1 rounded-lg px-2.5 text-[12.5px] font-medium hover:bg-accent" @click="jsonOpen = !jsonOpen">
          JSON
          <svg :class="cn('size-[13px] transition-transform', jsonOpen && 'rotate-180')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"></path></svg>
        </button>
        <button v-if="blocked" type="button" disabled class="h-[30px] cursor-not-allowed rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground opacity-40">Cannot build</button>
        <button
          v-else
          type="button"
          :disabled="busy"
          :class="cn('h-[30px] rounded-lg px-3 text-[12.5px] font-medium', preset.status === 'up-to-date' ? 'border border-border bg-background' : 'bg-primary text-primary-foreground')"
          @click="sync"
        >
          {{ actionLabel }}
        </button>
      </div>
    </div>
    <pre v-if="jsonOpen" class="max-h-[280px] overflow-auto rounded-b-xl border-t border-border bg-muted px-4 py-3 font-mono text-[11.5px] leading-[1.55]">{{ json }}</pre>
  </div>
</template>
