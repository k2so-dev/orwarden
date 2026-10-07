<script setup lang="ts" vapor>
import { cn } from "@/lib/utils";

defineProps<{ title?: string; lines: string[]; class?: string }>();
</script>

<template>
  <span :class="cn('group/tip relative inline-flex', $props.class)">
    <slot />
    <span
      class="pointer-events-none invisible absolute left-0 top-full z-40 mt-1.5 w-max max-w-[320px] whitespace-normal rounded-lg border border-border bg-popover p-2.5 text-left text-xs font-normal text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover/tip:visible group-hover/tip:opacity-100"
    >
      <span v-if="title" class="mb-1 block font-semibold">{{ title }}</span>
      <span v-for="(line, i) in lines" :key="i" class="block text-muted-foreground">{{ line }}</span>
    </span>
  </span>
</template>
