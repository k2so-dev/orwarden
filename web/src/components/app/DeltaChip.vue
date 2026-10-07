<script setup lang="ts" vapor>
import { computed } from "vue";
import { signedPct } from "@/lib/format";
import StatusBadge, { type BadgeKind } from "./StatusBadge.vue";

const props = defineProps<{ value: number | null | undefined; label?: string }>();

const kind = computed<BadgeKind>(() => {
  const v = props.value;
  if (v === null || v === undefined || Math.abs(v) < 0.005) return "mute";
  return v < 0 ? "ok" : "bad";
});
const text = computed(() => props.label ?? signedPct(props.value));
</script>

<template>
  <StatusBadge :kind="kind" class="tnum">{{ text }}</StatusBadge>
</template>
