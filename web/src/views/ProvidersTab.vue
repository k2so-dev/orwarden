<script setup lang="ts" vapor>
import { computed, ref, shallowRef } from "vue";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import Tip from "@/components/app/Tip.vue";
import Toggle from "@/components/app/Toggle.vue";
import ApplyDialog from "@/components/providers/ApplyDialog.vue";
import { client, unwrap, type ApplyResult, type HistoryItem, type ProviderRow } from "@/lib/api";
import { dateTime, money, signedMoney, signedPct } from "@/lib/format";
import { shortIssue, type TipLine } from "@/lib/issues";
import { act, dryRun, history, previewOnly, providers, reloadAfterWrite } from "@/stores/data";
import { viewQuery } from "@/stores/filters";

const pending = computed(() => providers.value?.pending ?? null);
const pendingCount = computed(() => (pending.value?.added.length ?? 0) + (pending.value?.removed.length ?? 0));
const VERDICT: Record<string, BadgeKind> = { ok: "ok", outlier: "warn", "hard-bad": "bad" };
const GRID = "grid grid-cols-[190px_170px_minmax(280px,1fr)_minmax(220px,.8fr)_150px_160px_64px] min-w-[1180px] items-center";

const rank = (r: ProviderRow) => (r.ban.inDesired ? 0 : r.ban.pending ? 1 : 2);
const rows = computed(() =>
  [...(providers.value?.rows ?? [])].sort(
    (a, b) => rank(a) - rank(b) || (a.effectPct ?? Infinity) - (b.effectPct ?? Infinity) || a.provider.localeCompare(b.provider),
  ),
);

function status(r: ProviderRow): { kind: BadgeKind; text: string } {
  if (r.ban.inGuardrail) return { kind: "bad", text: r.ban.auto ? "auto ban" : "manual ban" };
  const p = r.ban.pending;
  if (p) return { kind: "warn", text: `${p.action === "ban" ? "pending" : "unban"} ${p.streak} of ${p.needed} runs` };
  return { kind: "none", text: "none" };
}

function pendingNote(r: ProviderRow): string | null {
  if (r.ban.inDesired && !r.ban.inGuardrail) return "+ ban pending";
  if (!r.ban.inDesired && r.ban.inGuardrail) return "− unban pending";
  return null;
}

const modelName = (slug: string) => slug.split("/").pop() ?? slug;
const chipText = (m: ProviderRow["models"][number]) => `${modelName(m.slug)}: ${m.verdict === "ok" || m.reasons.length === 0 ? "ok" : shortIssue(m.reasons[0]!)}`;
const chipTip = (m: ProviderRow["models"][number]): TipLine[] =>
  m.reasons.length === 0
    ? [{ text: "No issues found.", tone: "muted" }]
    : m.reasons.map((text) => ({ text, tone: m.verdict === "hard-bad" ? "bad" : m.verdict === "outlier" ? "warn" : "fg" }));

function worstTone(r: ProviderRow): string {
  if (!r.worst) return "text-muted-foreground";
  return r.models.some((m) => m.verdict === "hard-bad") ? "text-bad" : "text-warn";
}

function effect(r: ProviderRow): { text: string; pct: string; tone: string } {
  if (r.effect === null) return { text: r.blocked ? "blocks a model" : "—", pct: "", tone: r.blocked ? "text-bad" : "text-muted-foreground" };
  const tiny = Math.abs(r.effectPct ?? 0) < 0.005;
  return {
    text: `${r.effect <= 0 ? "−" : "+"}${money(Math.abs(r.effect))}`,
    pct: `(${signedPct(r.effectPct)})`,
    tone: tiny ? "text-muted-foreground" : r.effect < 0 ? "text-ok" : "text-bad",
  };
}

async function setBan(r: ProviderRow, on: boolean) {
  const policy = on ? "ban" : r.ban.auto ? "allow" : null;
  await act(() => unwrap(client.providers[":slug"].policy.$put({ param: { slug: r.provider }, json: { policy } })));
  await reloadAfterWrite();
}

async function discard() {
  await act(() => unwrap(client.bans.discard.$post()), "Draft discarded", "Pending changes reset to the current guardrail");
  await reloadAfterWrite();
}

const dialog = ref(false);
const plan = shallowRef<ApplyResult | null>(null);
const busy = ref(false);

async function openDialog() {
  const res = await act(() => unwrap(client.bans.apply.$post({ json: { dryRun: true, view: viewQuery.value } })));
  if (!res) return;
  plan.value = res;
  dialog.value = true;
}

async function confirm() {
  if (dryRun.value) {
    dialog.value = false;
    previewOnly();
    return;
  }
  busy.value = true;
  const res = await act(
    () => unwrap(client.bans.apply.$post({ json: { dryRun: false, view: viewQuery.value } })),
    "Guardrail updated",
    (r) => `ignored_providers now has ${r.after.length} entries`,
  );
  busy.value = false;
  if (res) {
    dialog.value = false;
    await reloadAfterWrite();
  }
}

async function rollback(h: HistoryItem) {
  const res = await act(
    () => unwrap(client.bans.rollback.$post({ json: { runId: h.id } })),
    "Rolled back",
    [...h.added.map((p) => `+ ${p}`), ...h.removed.map((p) => `− ${p}`)].join(", ") + " reverted",
  );
  if (res) await reloadAfterWrite();
}

function who(h: HistoryItem): string {
  if (h.source === "manual") return "manual · you";
  if (h.source === "rollback") return "rollback · you";
  const reasons = [...new Set(h.decisions.filter((d) => d.action === "ban" || d.action === "unban").map((d) => d.reason))];
  return reasons.length ? `auto · ${reasons.join("; ")}` : "auto · scheduled run";
}

const entries = computed(() => history.value.filter((h) => h.added.length + h.removed.length > 0));
const btn = "h-8 rounded-lg px-3 text-[13px] font-medium";
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex items-start gap-2.5 rounded-[10px] border border-border px-4 py-3 text-[13px]">
      <svg class="mt-px size-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="10"></circle>
        <path d="M12 16v-4M12 8h.01"></path>
      </svg>
      <div>
        <b class="font-semibold">Global bans affect every model. Use presets for per-model control.</b>
        <span class="text-muted-foreground"> Bans are written to the workspace guardrail as <code class="font-mono">ignored_providers</code> and apply to every request from every app.</span>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2.5 rounded-xl border border-border bg-card py-2.5 pl-4 pr-3">
      <span class="text-[13px] font-semibold">Pending changes</span>
      <StatusBadge v-for="p in pending?.added ?? []" :key="'a' + p" kind="ok" class="h-[22px] text-xs">+ {{ p }}</StatusBadge>
      <StatusBadge v-for="p in pending?.removed ?? []" :key="'r' + p" kind="bad" class="h-[22px] text-xs">− {{ p }}</StatusBadge>
      <span v-if="pendingCount === 0" class="text-[13px] text-muted-foreground">None — draft matches the guardrail</span>
      <div class="ml-auto flex gap-2">
        <button type="button" :class="[btn, 'hover:bg-accent']" @click="discard">Discard</button>
        <button v-if="!dryRun" type="button" :class="[btn, 'border border-border bg-background hover:bg-accent']" @click="openDialog">Preview</button>
        <button type="button" :class="[btn, 'bg-primary text-primary-foreground']" @click="openDialog">{{ dryRun ? "Preview" : "Apply to guardrail" }}</button>
      </div>
    </div>

    <div class="overflow-x-auto rounded-xl border border-border bg-card">
      <div :class="[GRID, 'h-[34px] rounded-t-xl border-b border-border bg-muted text-[11.5px] font-medium text-muted-foreground']">
        <span class="px-4">Provider</span>
        <span class="px-2.5">Status</span>
        <span class="px-2.5">Models · verdict</span>
        <span class="px-2.5">Worst issue</span>
        <span class="px-2.5 text-right">Effect of banning</span>
        <span class="px-2.5">Drops below 2 good</span>
        <span class="px-2.5">Ban</span>
      </div>
      <div
        v-for="r in rows"
        :key="r.provider"
        :class="[GRID, 'min-h-[46px] border-b border-border py-1.5 text-[12.5px] last:border-b-0', pendingNote(r) && 'bg-muted']"
      >
        <div class="flex flex-col px-4 leading-tight">
          <span class="font-medium" :title="r.provider">{{ r.name }}</span>
          <span class="text-[11.5px] text-muted-foreground">{{ r.models.length }} model{{ r.models.length === 1 ? "" : "s" }}</span>
        </div>
        <div class="flex flex-col items-start gap-[3px] px-2.5">
          <StatusBadge :kind="status(r).kind">{{ status(r).text }}</StatusBadge>
          <span v-if="pendingNote(r)" class="text-[11px] font-medium text-warn">{{ pendingNote(r) }}</span>
        </div>
        <div class="flex flex-wrap gap-1 px-2.5">
          <Tip v-for="m in r.models" :key="m.slug" :title="`${m.name} · ${m.verdict}`" :lines="chipTip(m)">
            <StatusBadge :kind="VERDICT[m.verdict] ?? 'mute'" mono>{{ chipText(m) }}</StatusBadge>
          </Tip>
        </div>
        <div :class="['px-2.5 text-pretty', worstTone(r)]">{{ r.worst ?? "—" }}</div>
        <div :class="['tnum px-2.5 text-right font-medium', effect(r).tone]">
          {{ effect(r).text }}
          <span class="font-normal">{{ effect(r).pct }}</span>
        </div>
        <div class="px-2.5 text-xs text-warn">
          <template v-if="r.breaks.length > 0">⚠ {{ r.breaks.join(", ") }}</template>
        </div>
        <div class="px-2.5">
          <Toggle :model-value="r.ban.inDesired" :label="`Ban ${r.provider}`" @update:model-value="setBan(r, $event)" />
        </div>
      </div>
    </div>

    <div class="rounded-xl border border-border bg-card">
      <div class="border-b border-border px-4 py-3 text-[13px] font-semibold">History</div>
      <div v-if="entries.length === 0" class="px-4 py-3 text-[13px] text-muted-foreground">No guardrail changes yet.</div>
      <div
        v-for="h in entries"
        :key="h.id"
        class="grid grid-cols-[130px_1fr_240px_auto] items-center gap-3 border-b border-border px-4 py-2 text-[12.5px] last:border-b-0"
      >
        <span class="font-mono text-xs text-muted-foreground">{{ dateTime(h.startedAt) }}</span>
        <span class="flex flex-wrap gap-1">
          <StatusBadge v-for="p in h.added" :key="'a' + p" kind="bad">+ {{ p }}</StatusBadge>
          <StatusBadge v-for="p in h.removed" :key="'r' + p" kind="ok">− {{ p }}</StatusBadge>
        </span>
        <span class="truncate text-muted-foreground" :title="who(h)">{{ who(h) }}</span>
        <button type="button" :disabled="!h.patched" :title="h.patched ? 'Restore the list from before this change' : 'This run did not write to OpenRouter'" class="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40" @click="rollback(h)">
          <svg class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
          Rollback
        </button>
      </div>
    </div>
    <ApplyDialog v-model:open="dialog" :plan="plan" :dry-run="dryRun" :busy="busy" @confirm="confirm" />
  </div>
</template>
