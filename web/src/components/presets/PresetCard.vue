<script setup lang="ts" vapor>
import { computed, ref } from "vue";
import DeltaChip from "@/components/app/DeltaChip.vue";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import Tip from "@/components/app/Tip.vue";
import Toggle from "@/components/app/Toggle.vue";
import { client, unwrap, type PresetView } from "@/lib/api";
import { copy } from "@/lib/clipboard";
import { dateTime, money, pct, periodLabel, price, signedMoney, signedPct, uptime } from "@/lib/format";
import type { TipLine, Tone } from "@/lib/issues";
import { TONE_CLASS } from "@/lib/issues";
import { presetStatus } from "@/lib/presetStatus";
import { cn } from "@/lib/utils";
import { act, dryRun, presetsFailed, reloadAfterWrite, writeBlocked } from "@/stores/data";
import { scenarioLabel } from "@/stores/filters";
import { confirmAction } from "@/stores/confirm";
import { notify } from "@/stores/toast";

type Row = PresetView["ranked"][number];

const props = defineProps<{ preset: PresetView }>();

const status = computed(() => props.preset.status);
const badge = computed(() => presetStatus(props.preset));
const note = computed(() =>
  status.value === "up-to-date" && props.preset.syncedAt ? `Synced ${dateTime(props.preset.syncedAt, ", ")} · matches the saved ranking` : badge.value.tip,
);
const copyable = computed(() => badge.value.copyable && !presetsFailed.value);

const blocked = computed(() => status.value === "empty");
const min = computed(() => props.preset.policy.minQuantization);
const jsonOpen = ref(false);
const json = computed(() => JSON.stringify(props.preset.config, null, 2));
const busy = ref(false);
const days = computed(() => props.preset.horizonDays);
const current = computed(() => props.preset.profile.name);

const usd = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `$${price(v)}`);
const quantKind = (q: string): BadgeKind => (!props.preset.openWeights ? "none" : q === "fp4" || q === "int4" ? "bad" : q === "unknown" ? "warn" : "out");
const quantText = (q: string) => (props.preset.openWeights ? q : "closed");

function effTone(e: Row): Tone {
  if (e.vsCheapest === null) return "fg";
  if (e.vsCheapest < 0.005) return "ok";
  if (e.vsCheapest > 0.5) return "bad";
  if (e.vsCheapest > 0.2) return "warn";
  return "fg";
}

function rowTip(e: Row): TipLine[] {
  const p = props.preset.profile;
  return [
    { text: `Blend: ${pct(1 - p.h)} × in ${usd(e.pIn)} + ${pct(p.h)} × cache ${e.cacheKnown ? usd(e.pCache) : "n/a"} + ${p.r.toFixed(2)} × out ${usd(e.pOut)} = ${usd(e.costPerM)}`, tone: "fg" },
    { text: `Uptime ${uptime(e.uptime)} → effective ${usd(e.effectivePerM)} per 1M input`, tone: "fg" },
    { text: `Expected share ${pct(e.share, 1)} → ${money(e.costHorizon)} / ${periodLabel(days.value)}`, tone: "muted" },
    { text: e.vsCheapest === null ? "No cheaper reference" : e.vsCheapest < 0.005 ? "Cheapest eligible endpoint" : `${signedPct(e.vsCheapest)} vs cheapest eligible`, tone: effTone(e) === "fg" ? "muted" : effTone(e) },
    { text: `Score ${Math.round(e.overall)}${e.pinned ? " · pinned" : ""}`, tone: "muted" },
  ];
}

const effectiveTip: TipLine[] = [
  { text: "Price per 1M input tokens for this scenario: uncached input + cached input + output at the scenario's output/input ratio.", tone: "fg" },
  { text: "Divided by uptime, since failed requests fall through to the next provider.", tone: "muted" },
];
const shareTip: TipLine[] = [
  { text: "Expected share of requests under the preset's fallback order: each endpoint gets what the ones above it fail to serve.", tone: "fg" },
];

const leader = computed(() => props.preset.ranked[0] ?? null);
const leaderPremium = computed(() => {
  const l = leader.value;
  const c = props.preset.cheapest;
  if (!l || !c || l.tag === c.tag || l.vsCheapest === null || l.vsCheapest < 0.005) return null;
  return l.vsCheapest;
});
const leaderNote = computed(() => {
  const l = leader.value;
  const c = props.preset.cheapest;
  if (leaderPremium.value === null || !l || !c) return "";
  const why = props.preset.rankBy === "score"
    ? "Ranking weighs speed and reliability too; set Preset ranking to “Cheapest effective” in Settings to rank by price."
    : "It ranks first on uptime-adjusted price or because it is pinned.";
  return `#1 ${l.providerName} costs ${signedPct(leaderPremium.value)} more than the cheapest eligible endpoint (${c.providerName}). ${why}`;
});

const perMDelta = computed(() => {
  const { default: d, preset: p } = props.preset.perM;
  return d && p !== null ? p / d - 1 : null;
});

const scenarios = computed(() =>
  props.preset.scenarios.map((s) => {
    const delta = s.default !== null && s.preset !== null ? s.preset - s.default : null;
    return {
      name: s.name,
      label: scenarioLabel(s.name),
      current: s.name === current.value,
      def: money(s.default),
      pre: s.preset === null ? "no preset" : money(s.preset),
      rel: delta !== null && s.default ? delta / s.default : null,
      month: delta === null ? "—" : signedMoney((delta * 30) / days.value),
      monthTone: delta === null || Math.abs(delta) < 0.005 ? "text-muted-foreground" : delta < 0 ? "text-ok" : "text-bad",
    };
  }),
);

const policies = computed(() => {
  const p = props.preset.policy;
  return [
    ...(min.value && p.quantizations.length > 0 ? [`${min.value}+ only`] : []),
    ...(p.zdr ? ["ZDR"] : []),
    ...(p.fallbacks ? ["fallbacks within list"] : []),
    ...(p.tools ? ["tools required"] : []),
    props.preset.rankBy === "cost" ? "ranked by effective price" : "ranked by score",
  ];
});

const savingsClass = computed(() => ((props.preset.cost.saving ?? 0) <= 0 ? "text-ok" : "text-bad"));
const savings = computed(() => {
  const c = props.preset.cost;
  if (c.saving === null) return "";
  return `vs default routing: ${signedMoney(c.saving)} / ${days.value}d (${signedPct(c.savingPct)}) · ${scenarioLabel(current.value).toLowerCase()}`;
});

const actionLabel = computed(() => {
  if (dryRun.value) return "Preview";
  if (status.value === "not-created") return "Create preset";
  if (status.value === "out-of-date") return "Update preset";
  if (status.value === "foreign") return "Overwrite preset";
  if (status.value === "unknown") return "Sync preset";
  if (!props.preset.syncedAt) return "Pin preset";
  return "Re-sync";
});

async function patch(body: { autoSync?: boolean; pinned?: string[]; slug?: string }) {
  const res = await act(() => unwrap(client.presets.settings.$put({ json: { model: props.preset.model, ...body } })));
  if (res) await reloadAfterWrite();
  return res !== null;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const renaming = ref(false);
const slugDraft = ref("");
const slugValid = computed(() => SLUG_RE.test(slugDraft.value.trim()));

function startRename() {
  slugDraft.value = props.preset.slug;
  renaming.value = true;
}

async function rename() {
  const slug = slugDraft.value.trim();
  if (!SLUG_RE.test(slug)) return;
  if (slug === props.preset.slug) {
    renaming.value = false;
    return;
  }
  if (props.preset.syncedAt) {
    const ok = await confirmAction(
      `Rename to @preset/${slug}?`,
      `@preset/${props.preset.slug} stays on OpenRouter but is no longer updated from here. Clients must switch to the new id after you sync it.`,
      "Rename",
    );
    if (!ok) return;
  }
  if (await patch({ slug })) renaming.value = false;
}

function togglePin(tag: string) {
  const pinned = props.preset.pinned;
  void patch({ pinned: pinned.includes(tag) ? pinned.filter((t) => t !== tag) : [...pinned, tag] });
}

async function sync() {
  if (dryRun.value) {
    jsonOpen.value = true;
    notify("Preview only", `Dry-run: this config would be written to @preset/${props.preset.slug}. Nothing was sent.`, "info");
    return;
  }
  const edits = props.preset.remote?.edits ?? [];
  const removes = edits.length > 0 ? ` Syncing writes a new version with only model and provider routing, so these settings may be lost: ${edits.join(", ")}.` : "";
  const foreign = status.value === "foreign";
  const unchecked = status.value === "unknown";
  if (unchecked) {
    const ok = await confirmAction(
      `Write @preset/${props.preset.slug} without checking?`,
      "OpenRouter did not return the current preset, so edits made there or another model using this slug cannot be detected. Syncing replaces whatever is there.",
      "Write anyway",
    );
    if (!ok) return;
  } else if (foreign || edits.length > 0) {
    const ok = await confirmAction(
      foreign ? `Overwrite @preset/${props.preset.slug}?` : `Replace edits on @preset/${props.preset.slug}?`,
      foreign
        ? `${props.preset.remote?.model && props.preset.remote.model !== props.preset.model ? `This preset on OpenRouter routes ${props.preset.remote.model}. Clients using it will switch to ${props.preset.model}.` : "This preset on OpenRouter was not created from here and has a different provider list. Clients using it will switch to the generated list."}${removes} Rename this preset instead to keep both.`
        : `The preset on OpenRouter was edited there.${removes}`,
      foreign ? "Overwrite" : "Replace",
    );
    if (!ok) return;
  }
  busy.value = true;
  const created = status.value === "not-created";
  const accept: ("unknown" | "foreign" | "edits")[] = unchecked ? ["unknown"] : [...(foreign ? (["foreign"] as const) : []), ...(edits.length > 0 ? (["edits"] as const) : [])];
  const res = await act(() =>
    unwrap(client.presets.sync.$post({ json: { models: [props.preset.model], dryRun: false, accept, slugs: { [props.preset.model]: props.preset.slug } } })),
  );
  busy.value = false;
  const r = res?.[0];
  if (!r) return;
  if (r.status === "failed") notify("Write failed", r.error ?? r.slug, "err");
  else if (r.status === "skipped") notify("Nothing to sync", r.error ?? `@preset/${r.slug}`, "info");
  else notify(created ? "Preset created" : "Preset updated", `@preset/${r.slug}`);
  await reloadAfterWrite();
}

const GRID = "grid grid-cols-[20px_minmax(0,1fr)_60px_50px_50px_50px_70px_48px_56px_36px_28px] items-center gap-1.5";
const SCEN_GRID = "grid grid-cols-[minmax(0,1fr)_80px_88px_56px_92px] items-center gap-2";
</script>

<template>
  <div class="flex flex-col rounded-xl border border-border bg-card">
    <div class="flex flex-col gap-2.5 px-4 pb-3 pt-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <div class="text-[15px] font-semibold">{{ preset.name }}</div>
          <div class="text-xs text-muted-foreground">{{ note }}</div>
        </div>
        <StatusBadge :kind="badge.kind" class="h-[22px] text-[11.5px]">{{ badge.text }}</StatusBadge>
      </div>
      <div class="flex gap-2">
        <div :class="cn('flex h-9 min-w-0 flex-1 items-center rounded-lg border border-border bg-muted px-3 font-mono text-[13px]', !copyable && 'text-muted-foreground')" :title="preset.presetId">
          <span class="select-all truncate">{{ preset.presetId }}</span>
        </div>
        <button
          type="button"
          :disabled="!copyable"
          :title="copyable ? 'Copy the preset id' : badge.tip"
          class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
          @click="copy(preset.presetId)"
        >
          <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect width="14" height="14" x="8" y="8" rx="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg>
          Copy id
        </button>
        <button
          type="button"
          title="Change the preset slug"
          class="inline-flex h-9 items-center rounded-lg border border-border bg-background px-3 text-[13px] font-medium hover:bg-accent"
          @click="startRename"
        >
          Rename
        </button>
      </div>
      <form v-if="renaming" class="flex items-center gap-2" @submit.prevent="rename">
        <span class="font-mono text-[13px] text-muted-foreground">@preset/</span>
        <input
          v-model="slugDraft"
          :class="cn('h-8 min-w-0 flex-1 rounded-lg border bg-background px-2.5 font-mono text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', slugValid ? 'border-border' : 'border-bad')"
          spellcheck="false"
          @keydown.esc="renaming = false"
        />
        <button type="submit" :disabled="!slugValid" class="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground disabled:opacity-40">Save</button>
        <button type="button" class="inline-flex h-8 items-center rounded-lg border border-border px-3 text-[12.5px] font-medium hover:bg-accent" @click="renaming = false">Cancel</button>
      </form>
      <div v-if="renaming && !slugValid" class="text-xs text-bad">Lowercase letters, digits and hyphens, 2–63 characters.</div>
    </div>

    <div v-if="blocked" class="mx-4 mb-3.5 flex gap-2 rounded-lg bg-bad-bg px-3 py-2.5 text-[13px] text-bad">
      <svg class="mt-px size-[15px] flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4M12 17h.01"></path></svg>
      <span>
        <b class="font-semibold">{{ preset.blocker?.title ?? "No eligible provider." }}</b>
        <span class="text-foreground"> {{ preset.blocker?.text ?? "No endpoint passes the saved rules, so this preset cannot be built." }}</span>
      </span>
    </div>

    <template v-else>
      <div class="tnum border-t border-border text-[12.5px]">
        <div :class="[GRID, 'h-[30px] border-b border-border px-2.5 text-[11.5px] font-medium text-muted-foreground']">
          <span>#</span><span>Provider</span><span>Quant</span>
          <span class="text-right">In</span><span class="text-right">Out</span><span class="text-right">Cache</span>
          <span class="flex justify-end"><Tip title="Effective $ / 1M input" :lines="effectiveTip">Effective<svg class="ml-1 size-3 self-center" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg></Tip></span>
          <span class="flex justify-end"><Tip title="Traffic share" :lines="shareTip">Share<svg class="ml-1 size-3 self-center" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg></Tip></span>
          <span class="text-right">Uptime</span><span class="text-right">tok/s</span><span></span>
        </div>
        <div v-for="e in preset.ranked" :key="e.tag" :class="[GRID, 'h-[38px] border-b border-border px-2.5']">
          <span class="font-semibold">{{ e.rank }}</span>
          <span class="flex min-w-0 items-baseline gap-1.5 overflow-hidden whitespace-nowrap">
            <span class="font-medium">{{ e.providerName }}</span>
            <span class="truncate font-mono text-[11px] text-muted-foreground">{{ e.tag }}</span>
          </span>
          <span><StatusBadge :kind="quantKind(e.quantization)">{{ quantText(e.quantization) }}</StatusBadge></span>
          <span class="text-right">{{ usd(e.pIn) }}</span>
          <span class="text-right">{{ usd(e.pOut) }}</span>
          <span :class="['text-right', !e.cacheKnown && 'text-muted-foreground']">{{ e.cacheKnown ? usd(e.pCache) : "—" }}</span>
          <span class="flex justify-end">
            <Tip :title="`${e.providerName} · ${scenarioLabel(current)}`" :lines="rowTip(e)" :class="cn('font-semibold', TONE_CLASS[effTone(e)])">{{ usd(e.effectivePerM) }}</Tip>
          </span>
          <span class="text-right">{{ e.share > 0 && e.share < 0.001 ? "<0.1%" : pct(e.share, e.share < 0.1 && e.share >= 0.001 ? 1 : 0) }}</span>
          <span class="text-right">{{ uptime(e.uptime) }}</span>
          <span class="text-right">{{ e.tps === null ? "—" : Math.round(e.tps) }}</span>
          <button
            type="button"
            :title="e.pinned ? 'Unpin: rank this provider by score again' : 'Pin: keep this provider at the top of the preset regardless of score'"
            :aria-pressed="e.pinned"
            :class="cn('grid size-7 place-items-center rounded-md', e.pinned ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-accent')"
            @click="togglePin(e.tag)"
          >
            <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>
          </button>
        </div>
      </div>

      <div class="tnum grid grid-cols-3 gap-3 px-4 pt-3">
        <div class="flex flex-col gap-0.5">
          <span class="text-[11.5px] font-medium text-muted-foreground">Preset · $ / 1M input</span>
          <span class="flex items-baseline gap-1.5"><span class="text-[17px] font-semibold">{{ usd(preset.perM.preset) }}</span><DeltaChip :value="perMDelta" /></span>
        </div>
        <div class="flex flex-col gap-0.5">
          <span class="text-[11.5px] font-medium text-muted-foreground">Default routing</span>
          <span class="text-[17px] font-semibold">{{ usd(preset.perM.default) }}</span>
        </div>
        <div class="flex min-w-0 flex-col gap-0.5">
          <span class="text-[11.5px] font-medium text-muted-foreground">Cheapest of {{ preset.eligibleCount }} eligible</span>
          <span class="flex min-w-0 items-baseline gap-1.5">
            <span class="text-[17px] font-semibold">{{ usd(preset.cheapest?.costPerM) }}</span>
            <span class="truncate text-xs text-muted-foreground">{{ preset.cheapest?.providerName }}</span>
          </span>
        </div>
      </div>
      <div v-if="leaderNote" class="mx-4 mt-2.5 rounded-lg bg-warn-bg px-3 py-2 text-[12.5px] text-warn">{{ leaderNote }}</div>

      <div class="tnum mx-4 mt-3 rounded-lg border border-border text-[12.5px]">
        <div :class="[SCEN_GRID, 'h-[30px] border-b border-border px-3 text-[11.5px] font-medium text-muted-foreground']">
          <span>Cost by scenario · {{ periodLabel(days) }}</span>
          <span class="text-right">Default</span><span class="text-right">Preset</span><span class="text-right">Δ</span><span class="text-right">Δ / 30 days</span>
        </div>
        <div v-for="s in scenarios" :key="s.name" :class="[SCEN_GRID, 'h-8 border-b border-border px-3 last:border-b-0', s.current && 'font-semibold']">
          <span class="truncate">{{ s.label }}</span>
          <span class="text-right">{{ s.def }}</span>
          <span :class="['text-right', s.pre === 'no preset' && 'text-muted-foreground']">{{ s.pre }}</span>
          <span class="flex justify-end"><DeltaChip :value="s.rel" /></span>
          <span :class="['text-right', s.monthTone]">{{ s.month }}</span>
        </div>
      </div>

      <div class="flex flex-wrap gap-1.5 px-4 pt-3">
        <span v-for="p in policies" :key="p" class="inline-flex h-[22px] items-center rounded-full border border-border px-2 text-[11.5px] font-medium">{{ p }}</span>
      </div>
      <div class="tnum px-4 pb-3.5 pt-2.5 text-[13px] font-medium" :class="savingsClass">{{ savings }}</div>
    </template>

    <div class="mt-auto flex items-center gap-2.5 border-t border-border py-2.5 pl-4 pr-3">
      <Toggle :model-value="preset.autoSync" label="Auto-sync" @update:model-value="patch({ autoSync: $event })" />
      <span class="text-[12.5px]" :title="dryRun ? 'Dry-run is on: scheduled refreshes only plan the write' : 'Scheduled refreshes rewrite this preset whenever the saved ranking changes'">
        Auto-sync on schedule<span v-if="dryRun && preset.autoSync" class="text-warn"> · paused in dry-run</span>
      </span>
      <div class="ml-auto flex gap-1.5">
        <button v-if="!blocked" type="button" class="inline-flex h-[30px] items-center gap-1 rounded-lg px-2.5 text-[12.5px] font-medium hover:bg-accent" @click="jsonOpen = !jsonOpen">
          JSON
          <svg :class="cn('size-[13px] transition-transform', jsonOpen && 'rotate-180')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"></path></svg>
        </button>
        <button v-if="blocked" type="button" disabled class="h-[30px] cursor-not-allowed rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground opacity-40">Cannot build</button>
        <button
          v-else
          type="button"
          :disabled="busy || (!dryRun && writeBlocked !== null)"
          :title="!dryRun && writeBlocked ? writeBlocked : undefined"
          :class="cn('inline-flex h-[30px] items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium disabled:cursor-wait disabled:opacity-70', status === 'up-to-date' && !dryRun ? 'border border-border bg-background' : 'bg-primary text-primary-foreground')"
          @click="sync"
        >
          <svg v-if="busy" class="size-[13px] animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path></svg>
          {{ actionLabel }}
        </button>
      </div>
    </div>
    <pre v-if="jsonOpen" class="max-h-[280px] overflow-auto rounded-b-xl border-t border-border bg-muted px-4 py-3 font-mono text-[11.5px] leading-[1.55]">{{ json }}</pre>
  </div>
</template>
