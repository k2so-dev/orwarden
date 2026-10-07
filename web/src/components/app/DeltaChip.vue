<script setup lang="ts" vapor>
import { computed } from "vue";
import { signedPct } from "@/lib/format";
import { cn } from "@/lib/utils";

const props = defineProps<{ value: number | null | undefined; label?: string; class?: string }>();

const tone = computed(() => {
  const v = props.value;
  if (v === null || v === undefined) return "text-muted-foreground";
  if (Math.abs(v) < 0.005) return "bg-muted text-muted-foreground";
  return v < 0 ? "bg-ok-bg text-ok" : "bg-bad-bg text-bad";
});
const text = computed(() => props.label ?? (props.value === null || props.value === undefined ? "—" : signedPct(props.value)));
</script>

<template>
  <span :class="cn('tnum inline-flex h-[18px] items-center justify-center whitespace-nowrap rounded-[5px] px-1.5 text-[11px] font-semibold', tone, props.class)">{{ text }}</span>
</template>
