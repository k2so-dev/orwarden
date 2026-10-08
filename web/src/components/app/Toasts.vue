<script setup lang="ts" vapor>
import { dismiss, toasts, type Toast } from "@/stores/toast";

const DOT = { ok: "bg-ok", info: "bg-muted-foreground", err: "bg-bad" };

function run(t: Toast): void {
  dismiss(t.id);
  t.action?.run();
}
</script>

<template>
  <div class="fixed bottom-5 right-5 z-[70] flex w-[340px] flex-col gap-2" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="flex gap-2.5 rounded-[10px] border border-border bg-popover px-3.5 py-3 text-popover-foreground shadow-[0_8px_24px_rgb(0_0_0/.14)]">
      <span :class="['mt-1.5 size-2 flex-none rounded-full', DOT[t.kind]]"></span>
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-semibold">{{ t.title }}</div>
        <div v-if="t.desc" class="text-[12.5px] text-muted-foreground [overflow-wrap:anywhere]">{{ t.desc }}</div>
      </div>
      <button v-if="t.action" type="button" class="h-7 flex-none self-center rounded-md border border-border px-2.5 text-[12.5px] font-medium hover:bg-accent" @click="run(t)">{{ t.action.label }}</button>
      <button type="button" aria-label="Dismiss" class="grid size-5 flex-none place-items-center rounded text-muted-foreground hover:text-foreground" @click="dismiss(t.id)">
        <svg class="size-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"></path></svg>
      </button>
    </div>
  </div>
</template>
