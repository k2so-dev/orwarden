<script setup lang="ts" vapor>
import { computed, reactive, ref, watch } from "vue";
import Segmented from "@/components/app/Segmented.vue";
import StatusBadge from "@/components/app/StatusBadge.vue";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { client, unwrap, type Settings } from "@/lib/api";
import { inDays } from "@/lib/format";
import { act, loadAll, refreshNow, reloadAfterWrite, settings, status } from "@/stores/data";
import { notify } from "@/stores/toast";
import { QUANT_OPTIONS } from "@/stores/filters";
import { settingsOpen } from "@/stores/ui";

const INTERVALS = [
  { value: "*/15 * * * *", label: "15 min" },
  { value: "0 * * * *", label: "1 h" },
  { value: "0 */6 * * *", label: "6 h" },
  { value: "0 0 * * *", label: "24 h" },
];
const RANK_OPTIONS = [
  { value: "score", label: "Weighted score" },
  { value: "cost", label: "Cheapest effective" },
];

const draft = reactive<{ value: Settings | null }>({ value: null });
const saving = ref(false);
const newPrefix = ref("");
const newQuant = ref("fp4");
const replacing = ref(false);
const newKey = ref("");

watch(settingsOpen, (open) => {
  if (open && settings.value) draft.value = structuredClone(JSON.parse(JSON.stringify(settings.value)));
  replacing.value = false;
  newKey.value = "";
});

const s = computed(() => draft.value);
const interval = computed({
  get: () => s.value?.refreshCron ?? "",
  set: (v: string) => {
    if (draft.value) draft.value.refreshCron = v;
  },
});
const intervalOptions = computed(() =>
  INTERVALS.some((o) => o.value === interval.value) ? INTERVALS : [...INTERVALS, { value: interval.value, label: interval.value }],
);
const exceptions = computed(() => Object.entries(s.value?.filters.nativeQuantization ?? {}));
const expiry = computed(() => status.value?.key.expiresAt ?? null);
const expiryText = computed(() => (expiry.value ? new Date(expiry.value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Never"));
const expirySoon = computed(() => expiry.value !== null && Date.parse(expiry.value) - Date.now() < 14 * 86_400_000);
const workspaces = computed(() => status.value?.workspaces ?? []);
const currentWorkspace = computed(() => s.value?.workspaceId ?? status.value?.workspace?.id ?? "");
const rankBy = computed({
  get: () => s.value?.presets.rankBy ?? "score",
  set: (v: string) => {
    if (draft.value) draft.value.presets.rankBy = v as Settings["presets"]["rankBy"];
  },
});
const keyLabel = computed(() => status.value?.key.label ?? (status.value?.key.source === "env" ? "set from environment" : "not set"));

function addException() {
  const prefix = newPrefix.value.trim();
  if (!prefix || !draft.value) return;
  draft.value.filters.nativeQuantization[prefix] = newQuant.value;
  newPrefix.value = "";
}

function removeException(prefix: string) {
  if (draft.value) delete draft.value.filters.nativeQuantization[prefix];
}

async function save() {
  const d = draft.value;
  if (!d) return;
  saving.value = true;
  const workspaceChanged = (d.workspaceId ?? null) !== (settings.value?.workspaceId ?? null);
  const res = await act(
    () =>
      unwrap(
        client.settings.$put({
          json: {
            refreshCron: d.refreshCron,
            workspaceId: d.workspaceId,
            filters: d.filters,
            scoring: d.scoring,
            optimizer: d.optimizer,
            presets: d.presets,
            alerts: { webhook: d.alerts.webhook || null, telegramBotToken: d.alerts.telegramBotToken || null, telegramChatId: d.alerts.telegramChatId || null },
          },
        }),
      ),
    "Settings saved",
    "Next refresh uses the new rules",
  );
  saving.value = false;
  if (res) {
    settings.value = res;
    settingsOpen.value = false;
    if (workspaceChanged) await refreshNow(false);
    else await reloadAfterWrite();
  }
}

async function replaceKey() {
  if (newKey.value.trim().length === 0) return;
  const res = await act(() => unwrap(client.key.$put({ json: { key: newKey.value.trim() } })), "Key replaced");
  if (res) {
    replacing.value = false;
    newKey.value = "";
    await loadAll();
  }
}

async function removeKey() {
  const res = await act(() => unwrap(client.key.$delete()), "Key removed");
  if (res) {
    settingsOpen.value = false;
    await loadAll();
  }
}

async function testAlert() {
  await save();
  const d = draft.value;
  const target = d?.alerts.telegramChatId ? `Telegram · chat ${d.alerts.telegramChatId}` : d?.alerts.webhook ? `Webhook · ${d.alerts.webhook}` : "No channel configured";
  const res = await act(() => unwrap(client.alerts.test.$post()));
  if (res) notify("Test alert sent", target);
}

const input = "h-8 rounded-lg border border-border bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50";
const num = `${input} w-16 text-right`;
const row = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 py-1.5";
const section = "mt-2 border-t border-border pb-1.5 pt-[18px] text-[11.5px] font-semibold uppercase tracking-[.06em] text-muted-foreground first:mt-0 first:border-t-0 first:pt-4";
const btn = "h-8 rounded-lg border border-border bg-background px-3 text-[13px] font-medium hover:bg-accent";
</script>

<template>
  <Sheet v-model:open="settingsOpen">
    <SheetContent side="right" class="flex w-[520px] max-w-full flex-col gap-0 p-0 sm:max-w-[520px]">
      <SheetHeader class="border-b border-border px-6 pb-4 pt-5">
        <SheetTitle class="text-base font-semibold">Settings</SheetTitle>
        <SheetDescription class="text-[13px]">Stored on this server. OpenRouter only changes on Apply.</SheetDescription>
      </SheetHeader>
      <div v-if="s" class="flex-1 overflow-y-auto px-6 pb-6 text-[13px]">
        <div :class="section">OpenRouter</div>
        <div class="flex flex-col gap-1.5 py-1.5">
          <span class="font-medium">Management key</span>
          <div v-if="!replacing" class="flex gap-1.5">
            <div class="flex h-8 flex-1 items-center rounded-lg border border-border px-2.5 font-mono text-[12.5px] text-muted-foreground">{{ keyLabel }}</div>
            <button type="button" :class="btn" @click="replacing = true">Replace</button>
            <button v-if="status?.key.source === 'dashboard'" type="button" :class="[btn, 'border-transparent bg-bad-bg text-bad hover:opacity-90']" @click="removeKey">Remove</button>
          </div>
          <div v-else class="flex gap-1.5">
            <input v-model="newKey" type="password" placeholder="sk-or-v1-…" :class="[input, 'flex-1 font-mono']" />
            <button type="button" :class="btn" @click="replaceKey">Save key</button>
            <button type="button" :class="[btn, 'border-transparent']" @click="replacing = false">Cancel</button>
          </div>
        </div>
        <div v-if="workspaces.length > 0" :class="row">
          <div>
            <div class="font-medium">Workspace</div>
            <div class="text-xs text-muted-foreground">Guardrail and usage come from this workspace</div>
          </div>
          <select :value="currentWorkspace" :class="[input, 'w-[200px]']" @change="s.workspaceId = ($event.target as HTMLSelectElement).value">
            <option v-for="w in workspaces" :key="w.id" :value="w.id">{{ w.name }}</option>
          </select>
        </div>
        <div :class="row">
          <span class="font-medium">Key expiry</span>
          <span class="flex items-center gap-2">
            <span class="tnum">{{ expiryText }}</span>
            <StatusBadge v-if="expiry" :kind="expirySoon ? 'warn' : 'mute'">{{ inDays(expiry) }}</StatusBadge>
          </span>
        </div>

        <div :class="section">Schedule</div>
        <div :class="row">
          <span class="font-medium">Refresh interval</span>
          <Segmented v-model="interval" :options="intervalOptions" size="sm" />
        </div>

        <div :class="section">Quality rules</div>
        <div :class="row">
          <span class="font-medium">Min quantization</span>
          <select v-model="s.filters.minQuantization" :class="[input, 'w-[100px]']">
            <option v-for="q in QUANT_OPTIONS" :key="q.value" :value="q.value">{{ q.value }}</option>
          </select>
        <div class="col-span-2 flex flex-col gap-2">
          <div>
            <div class="font-medium">Native quantization exceptions</div>
            <div class="text-xs text-muted-foreground">Models trained in fp4 are not penalised</div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <span v-for="[prefix, quant] in exceptions" :key="prefix" class="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted px-2 font-mono text-[11.5px]">
              {{ prefix }} → {{ quant }}
              <button type="button" class="text-muted-foreground hover:text-foreground" :aria-label="`Remove ${prefix}`" @click="removeException(prefix)">×</button>
            </span>
            <input v-model="newPrefix" placeholder="vendor/model" :class="[input, 'h-6 w-32 font-mono text-xs']" @keydown.enter="addException" />
            <button type="button" class="h-6 rounded-md border border-dashed border-border px-2 text-xs hover:bg-accent" @click="addException">+ Add</button>
          </div>
        </div>
          <span class="font-medium">Min uptime (1d)</span>
          <div class="flex items-center gap-1.5">
            <input :value="Math.round(s.filters.minUptime * 100)" type="number" min="50" max="100" :class="num" @input="s.filters.minUptime = Number(($event.target as HTMLInputElement).value) / 100" />
            <span class="text-muted-foreground">%</span>
          </div>
          <div>
            <div class="font-medium">Output outlier threshold</div>
            <div class="text-xs text-muted-foreground">outlier at ×{{ s.filters.outliers.outVsMedian }}, hard-bad at ×{{ s.filters.outliers.hardOutVsMedian }} median</div>
          </div>
          <div class="flex gap-1.5">
            <input v-model.number="s.filters.outliers.outVsMedian" type="number" step="0.1" min="1" :class="[num, 'w-14']" aria-label="Outlier multiple" />
            <input v-model.number="s.filters.outliers.hardOutVsMedian" type="number" step="0.1" min="1" :class="[num, 'w-14']" aria-label="Hard-bad multiple" />
          </div>
          <div>
            <div class="font-medium">Cache outlier threshold</div>
            <div class="text-xs text-muted-foreground">cache read price as a multiple of the median cache price</div>
          </div>
          <input v-model.number="s.filters.outliers.cacheRatioVsMedian" type="number" step="0.1" min="1" :class="num" />
          <div>
            <div class="font-medium">Penalty: unknown quantization</div>
            <div class="text-xs text-muted-foreground">points off the overall score · open-weight models only</div>
          </div>
          <input v-model.number="s.scoring.unknownQuantPenalty" type="number" min="0" max="100" :class="num" />
        </div>

        <div :class="section">Bans</div>
        <div :class="row">
          <span class="font-medium">Min good providers per model</span>
          <input v-model.number="s.optimizer.minEndpointsPerModel" type="number" min="1" max="10" :class="num" />
          <div>
            <div class="font-medium">Hysteresis</div>
            <div class="text-xs text-muted-foreground">ban after N bad runs / unban after M good runs</div>
          </div>
          <div class="flex gap-1.5">
            <input v-model.number="s.optimizer.hysteresis.banAfterRuns" type="number" min="1" :class="[num, 'w-14']" />
            <input v-model.number="s.optimizer.hysteresis.unbanAfterRuns" type="number" min="1" :class="[num, 'w-14']" />
          </div>
          <span class="font-medium">Max changes per run</span>
          <input v-model.number="s.optimizer.maxChangesPerRun" type="number" min="1" max="50" :class="num" />
        </div>

        <div :class="section">Presets</div>
        <div :class="row">
          <span class="font-medium">Top N providers</span>
          <input v-model.number="s.presets.topN" type="number" min="1" max="20" :class="num" />
          <div>
            <div class="font-medium">Ranking</div>
            <div class="text-xs text-muted-foreground">order of providers inside a preset</div>
          </div>
          <Segmented v-model="rankBy" :options="RANK_OPTIONS" size="sm" />
          <span class="font-medium">Naming pattern</span>
          <input v-model="s.presets.slugPattern" :class="[input, 'w-[180px] font-mono text-[12.5px]']" />
        </div>

        <div :class="section">Alerts</div>
        <div class="flex flex-col gap-2.5 py-1.5">
          <div class="grid grid-cols-2 gap-2">
            <label class="flex flex-col gap-1"><span class="font-medium">Telegram bot token</span><input v-model="s.alerts.telegramBotToken" type="password" autocomplete="off" :class="[input, 'font-mono text-[12.5px]']" /></label>
            <label class="flex flex-col gap-1"><span class="font-medium">Chat id</span><input v-model="s.alerts.telegramChatId" :class="[input, 'font-mono text-[12.5px]']" /></label>
          </div>
          <label class="flex flex-col gap-1">
            <span class="font-medium">Webhook URL</span>
            <span class="flex gap-1.5">
              <input v-model="s.alerts.webhook" placeholder="https://…" :class="[input, 'flex-1 font-mono text-[12.5px]']" />
              <button type="button" :class="btn" @click="testAlert">Test</button>
            </span>
          </label>
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t border-border px-6 py-3.5">
        <button type="button" class="h-[34px] rounded-lg border border-border bg-background px-3.5 text-[13px] font-medium hover:bg-accent" @click="settingsOpen = false">Cancel</button>
        <button type="button" :disabled="saving" class="h-[34px] rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:opacity-50" @click="save">Save settings</button>
      </div>
    </SheetContent>
  </Sheet>
</template>
