<script setup lang="ts" vapor>
import { computed } from "vue";

const props = defineProps<{ price: number; speed: number; reliability: number; overall: number }>();

const bars = computed(() => [
  { key: "price", width: `${props.price}%` },
  { key: "speed", width: `${props.speed}%` },
  { key: "reliability", width: `${props.reliability}%` },
]);
</script>

<template>
  <span class="flex items-center gap-2">
    <span class="flex w-14 flex-col gap-[2px]">
      <span v-for="b in bars" :key="b.key" class="block h-[3px] rounded-[2px] bg-muted">
        <span class="block h-full rounded-[2px] bg-muted-foreground" :style="{ width: b.width }"></span>
      </span>
    </span>
    <span class="tnum w-7 text-right text-[12.5px] font-bold">{{ Math.round(overall) }}</span>
  </span>
</template>
