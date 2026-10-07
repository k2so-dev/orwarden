<script setup lang="ts" vapor>
import type { TipLine } from "@/lib/issues";
import { cn } from "@/lib/utils";
import { hideTip, showTip } from "@/stores/tip";

const props = defineProps<{ title: string; lines: TipLine[]; class?: string }>();
const show = (e: Event) => showTip(e, props.title, props.lines);
</script>

<template>
  <span :class="cn('inline-flex cursor-help', props.class)" tabindex="0" @mouseenter="show" @focus="show" @mouseleave="hideTip" @blur="hideTip">
    <slot />
  </span>
</template>
