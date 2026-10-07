<script setup lang="ts" vapor>
import { TONE_CLASS } from "@/lib/issues";
import { tip } from "@/stores/tip";
</script>

<template>
  <div
    v-if="tip"
    role="tooltip"
    class="pointer-events-none fixed z-[80] flex w-max max-w-[320px] flex-col gap-1 rounded-lg border border-border bg-popover px-3 py-2.5 text-popover-foreground shadow-[0_8px_24px_rgb(0_0_0/.14)]"
    :style="{ left: `${tip.x}px`, top: `${tip.y}px` }"
  >
    <div class="text-xs font-semibold">{{ tip.title }}</div>
    <div v-for="(l, i) in tip.lines" :key="i" class="flex gap-1.5 text-xs leading-[1.4]">
      <span :class="TONE_CLASS[l.tone]">●</span>
      <span>{{ l.text }}</span>
    </div>
  </div>
</template>
