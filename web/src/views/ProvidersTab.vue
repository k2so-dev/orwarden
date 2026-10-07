<script setup lang="ts" vapor>
import { computed, ref, shallowRef } from "vue";
import StatusBadge, { type BadgeKind } from "@/components/app/StatusBadge.vue";
import Toggle from "@/components/app/Toggle.vue";
import ApplyDialog from "@/components/providers/ApplyDialog.vue";
import { client, unwrap, type ApplyResult, type ProviderRow } from "@/lib/api";
import { ago, money, pct } from "@/lib/format";
import { act, dryRun, history, providers, reloadAfterWrite } from "@/stores/data";

const rows = computed(() => providers.value?.rows ?? []);
const pending = computed(() => providers.value?.pending ?? null);
const pendingCount = computed(() => (pending.value?.added.length ?? 0) + (pending.value?.removed.length ?? 0));
const VERDICT: Record<string, BadgeKind> = { ok: "ok", outlier: "warn", "hard-bad": "bad" };
const GRID = "grid grid-cols-[190px_170px_minmax(280px,1fr)_minmax(220px,.8fr)_150px_160px_64px] min-w-[1180px] items-center";

function status(r: ProviderRow): { kind: BadgeKind; text: string } {
  if (r.ban.inGuardrail) return { kind: "bad", text: r.ban.auto ? "Auto-banned" : "Banned" };
  return { kind: "ok", text: "Active" };
}

function pendingNote(r: ProviderRow): { text: string; kind: "bad" | "ok" | "mute" } | null {
  if (r.ban.inDesired && !r.ban.inGuardrail) return { text: "Will be banned", kind: "bad" };
  if (!r.ban.inDesired && r.ban.inGuardrail) return { text: "Will be unbanned", kind: "ok" };
  const p = r.ban.pending;
  if (p) return { text: `${p.action} in ${p.needed - p.streak} more run(s)`, kind: "mute" };
  return null;
}

const NOTE_CLASS = { bad: "text-bad", ok: "text-ok", mute: "text-muted-foreground" };

async function setBan(r: ProviderRow, on: boolean) {
  const policy = on ? "ban" : r.ban.auto ? "allow" : null;
  await act(() => unwrap(client.providers[":slug"].policy.$put({ param: { slug: r.provider }, json: { policy } })));
  await reloadAfterWrite();
}

async function discard() {
  await act(() => unwrap(client.bans.discard.$post()), "Draft discarded");
  await reloadAfterWrite();
}

const dialog = ref(false);
const plan = shallowRef<ApplyResult | null>(null);
const busy = ref(false);

async function openDialog() {
  const res = await act(() => unwrap(client.bans.apply.$post({ json: { dryRun: true } })));
  if (!res) return;
  plan.value = res;
  dialog.value = true;
}

async function confirm() {
  busy.value = true;
  const res = await act(() => unwrap(client.bans.apply.$post({ json: { dryRun: false } })), "Guardrail updated");
  busy.value = false;
  if (res) {
    dialog.value = false;
    await reloadAfterWrite();
  }
}

async function rollback(runId: number) {
  const res = await act(() => unwrap(client.bans.rollback.$post({ json: { runId } })), "Rolled back");
  if (res) await reloadAfterWrite();
}

const entries = computed(() => history.value.filter((h) => h.added.length + h.removed.length > 0));
const SOURCE: Record<string, string> = { manual: "manual · you", auto: "auto · scheduled run", rollback: "rollback · you" };
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
      <StatusBadge v-for="p in pending?.added ?? []" :key="'a' + p" kind="bad" class="h-[22px] text-xs">+ ban {{ p }}</StatusBadge>
      <StatusBadge v-for="p in pending?.removed ?? []" :key="'r' + p" kind="ok" class="h-[22px] text-xs">− unban {{ p }}</StatusBadge>
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
        :class="[GRID, 'min-h-[46px] border-b border-border py-1.5 text-[12.5px] last:border-b-0', r.ban.inDesired && 'bg-muted/40']"
      >
        <div class="flex flex-col px-4 leading-tight">
          <span class="font-medium">{{ r.provider }}</span>
          <span class="text-[11.5px] text-muted-foreground">{{ r.name }}</span>
        </div>
        <div class="flex flex-col items-start gap-[3px] px-2.5">
          <StatusBadge :kind="status(r).kind">{{ status(r).text }}</StatusBadge>
          <span v-if="pendingNote(r)" :class="['text-[11px] font-medium', NOTE_CLASS[pendingNote(r)!.kind]]">{{ pendingNote(r)!.text }}</span>
        </div>
        <div class="flex flex-wrap gap-1 px-2.5">
          <StatusBadge v-for="m in r.models" :key="m.slug" :kind="VERDICT[m.verdict] ?? 'mute'" mono :title="m.reasons.join('; ')">{{ m.slug.split("/").pop() }} · {{ m.verdict }}</StatusBadge>
        </div>
        <div class="px-2.5 text-pretty" :class="r.worst ? 'text-foreground' : 'text-muted-foreground'">{{ r.worst ?? "—" }}</div>
        <div class="tnum px-2.5 text-right font-medium" :class="(r.effect ?? 0) > 0 ? 'text-ok' : 'text-muted-foreground'">
          {{ r.effect === null ? "—" : money(r.effect) }}
          <span class="font-normal">({{ r.effectPct === null ? "—" : pct(r.effectPct) }})</span>
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
        <span class="font-mono text-xs text-muted-foreground">{{ ago(h.startedAt) }}</span>
        <span class="flex flex-wrap gap-1">
          <StatusBadge v-for="p in h.added" :key="'a' + p" kind="bad">+ {{ p }}</StatusBadge>
          <StatusBadge v-for="p in h.removed" :key="'r' + p" kind="ok">− {{ p }}</StatusBadge>
        </span>
        <span class="text-muted-foreground">{{ SOURCE[h.source] }}</span>
        <button v-if="h.patched" type="button" class="inline-flex h-7 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium hover:bg-accent" @click="rollback(h.id)">
          <svg class="size-[13px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
          Rollback
        </button>
        <span v-else></span>
      </div>
    </div>
    <ApplyDialog v-model:open="dialog" :plan="plan" :dry-run="dryRun" :busy="busy" @confirm="confirm" />
  </div>
</template>
