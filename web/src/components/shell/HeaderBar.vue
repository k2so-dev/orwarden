<script setup lang="ts" vapor>
import { computed } from "vue";
import { client, unwrap } from "@/lib/api";
import { clock } from "@/stores/ui";
import { ago, dateTime, inDays, inFuture } from "@/lib/format";
import { cn } from "@/lib/utils";
import Segmented from "@/components/app/Segmented.vue";
import StatusBadge from "@/components/app/StatusBadge.vue";
import Tip from "@/components/app/Tip.vue";
import { act, dryRun, loadSettings, logout, refreshNow, refreshing, status } from "@/stores/data";
import { confirmAction } from "@/stores/confirm";
import { settingsOpen, theme, toggleTheme } from "@/stores/ui";

const MODES = [
  { value: "dry-run", label: "Dry-run" },
  { value: "apply", label: "Apply" },
];

async function setMode(value: string): Promise<void> {
  if (value === (dryRun.value ? "dry-run" : "apply")) return;
  if (value === "apply") {
    const ok = await confirmAction(
      "Switch to Apply?",
      "Write buttons, scheduled bans and preset auto-sync will change the guardrail and presets on OpenRouter for every app in this workspace.",
      "Switch to Apply",
    );
    if (!ok) return;
  }
  await act(
    async () => {
      await unwrap(client.settings.$put({ json: { mode: value } }));
      await loadSettings();
    },
    value === "apply" ? "Apply mode on" : "Dry-run mode on",
    value === "apply" ? "Writes go to OpenRouter" : "Nothing is written to OpenRouter",
  );
}

const mode = computed({
  get: () => (dryRun.value ? "dry-run" : "apply"),
  set: (value: string) => {
    void setMode(value);
  },
});

const keyPill = computed(() => {
  const s = status.value;
  if (!s) return { dot: "bg-muted-foreground", label: "…", sub: "" };
  switch (s.health) {
    case "no-key":
      return { dot: "bg-muted-foreground", label: "No key", sub: "" };
    case "invalid-key":
      return { dot: "bg-bad", label: "Invalid key", sub: "401 from OpenRouter" };
    default: {
      const exp = s.key.expiresAt;
      return { dot: "bg-ok", label: "Connected", sub: exp ? `expires ${inDays(exp, clock.value.getTime())}` : "no expiry" };
    }
  }
});

const keyTip = computed(() => {
  const s = status.value;
  if (!s || s.health === "no-key") return "No key stored yet.";
  if (s.health === "invalid-key") return "OpenRouter rejected the key (401). Replace it in Settings.";
  const parts = [s.key.label ?? (s.key.source === "env" ? "Key from environment" : "Stored key"), s.workspace?.name ?? "", s.key.expiresAt ? `expires ${dateTime(s.key.expiresAt, ", ")}` : "no expiry"];
  return parts.filter(Boolean).join(" · ");
});
const dataLabel = computed(() => (refreshing.value ? "Refreshing…" : status.value?.takenAt ? `Data ${ago(status.value.takenAt, clock.value.getTime())}` : "No data yet"));
const stale = computed(() => ["stale", "unreachable", "invalid-key"].includes(status.value?.health ?? "") && Boolean(status.value?.takenAt));
const next = computed(() =>
  status.value?.nextRunAt && (status.value.health === "ok" || status.value.health === "stale") ? `next in ${inFuture(status.value.nextRunAt, clock.value.getTime())}` : "",
);
const noKey = computed(() => status.value?.health === "no-key");
const workspace = computed(() => status.value?.workspace?.name ?? "—");
const pill = "inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2.5 text-xs text-muted-foreground";
const iconButton = "grid size-8 place-items-center rounded-lg text-foreground hover:bg-accent";
</script>

<template>
  <header class="sticky top-0 z-30 flex h-14 items-center gap-4 border-b border-border bg-background px-[max(20px,calc((100%-1640px)/2))]">
    <div class="flex flex-none items-center gap-2.5">
      <div class="grid size-[26px] place-items-center rounded-[7px] bg-primary font-mono text-sm font-semibold text-primary-foreground">r</div>
      <span class="text-[15px] font-semibold tracking-tight">orwarden</span>
      <span class="text-muted-foreground/50">/</span>
      <span class="text-[13px] text-muted-foreground">{{ workspace }}</span>
    </div>
    <div class="flex min-w-0 flex-1 flex-wrap items-center justify-center gap-2">
      <Tip title="OpenRouter management key" :lines="[{ text: keyTip, tone: 'fg' }]" :class="pill">
        <span :class="cn('size-[7px] rounded-full', keyPill.dot)"></span>
        <span class="font-medium text-foreground">{{ keyPill.label }}</span>
        <span v-if="keyPill.sub">· {{ keyPill.sub }}</span>
      </Tip>
      <span :class="pill">
        {{ dataLabel }}
        <StatusBadge v-if="stale" kind="warn" class="h-[18px] rounded-[5px] px-1.5">stale</StatusBadge>
      </span>
      <span v-if="next" :class="pill">{{ next }}</span>
      <Segmented v-model="mode" :options="MODES" size="sm" />
    </div>
    <div class="flex flex-none items-center gap-1">
      <button
        type="button"
        class="mr-1 inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-[13px] font-medium hover:bg-accent"
        :disabled="refreshing"
        @click="refreshNow(false)"
      >
        <svg :class="cn('size-[15px]', refreshing && 'animate-spin')" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
          <path d="M21 3v5h-5"></path>
        </svg>
        Refresh now
      </button>
      <button type="button" title="Settings" :class="iconButton" @click="settingsOpen = true">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 7h-9"></path>
          <path d="M14 17H5"></path>
          <circle cx="17" cy="17" r="3"></circle>
          <circle cx="7" cy="7" r="3"></circle>
        </svg>
      </button>
      <button type="button" title="Theme" :class="iconButton" @click="toggleTheme">
        <svg v-if="theme === 'light'" class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"></path>
        </svg>
        <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="4"></circle>
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"></path>
        </svg>
      </button>
      <button type="button" title="Sign out" :class="iconButton" @click="logout">
        <svg class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
          <path d="m16 17 5-5-5-5"></path>
          <path d="M21 12H9"></path>
        </svg>
      </button>
    </div>
  </header>
  <div
    v-if="dryRun && !noKey"
    class="flex h-8 items-center justify-center gap-2.5 border-b border-border bg-warn-bg text-[12.5px] font-medium text-warn"
  >
    <span>Dry-run: nothing is written to OpenRouter. Write buttons show a preview.</span>
    <button type="button" class="font-semibold underline underline-offset-[3px]" @click="mode = 'apply'">Switch to Apply</button>
  </div>
</template>
