<script setup lang="ts" vapor>
import { toasts } from "@/stores/toast";

const DOT = { ok: "bg-ok", info: "bg-muted-foreground", err: "bg-bad" };
</script>

<template>
  <div class="fixed bottom-5 right-5 z-[70] flex w-[340px] flex-col gap-2" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="flex gap-2.5 rounded-[10px] border border-border bg-popover px-3.5 py-3 text-popover-foreground shadow-[0_8px_24px_rgb(0_0_0/.14)]">
      <span :class="['mt-1.5 size-2 flex-none rounded-full', DOT[t.kind]]"></span>
      <div class="min-w-0">
        <div class="text-[13px] font-semibold">{{ t.title }}</div>
        <div v-if="t.desc" class="text-[12.5px] text-muted-foreground [overflow-wrap:anywhere]">{{ t.desc }}</div>
      </div>
    </div>
  </div>
</template>
