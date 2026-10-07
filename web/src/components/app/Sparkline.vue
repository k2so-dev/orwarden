<script setup lang="ts" vapor>
import { computed } from "vue";

const props = withDefaults(defineProps<{ values: number[]; width?: number; height?: number }>(), { width: 120, height: 28 });

const points = computed(() => {
  const v = props.values;
  if (v.length < 2) return "";
  const min = Math.min(...v);
  const span = Math.max(...v) - min || 1;
  const pad = 2;
  return v
    .map((x, i) => {
      const px = (i / (v.length - 1)) * (props.width - pad * 2) + pad;
      const py = props.height - pad - ((x - min) / span) * (props.height - pad * 2);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(" ");
});
</script>

<template>
  <svg :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" class="text-muted-foreground">
    <polyline :points="points" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" />
  </svg>
</template>
