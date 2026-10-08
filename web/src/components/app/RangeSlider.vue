<script setup lang="ts" vapor>
import { computed } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{ min: number; max: number; step: number; class?: string; disabled?: boolean }>();
const model = defineModel<number>({ required: true });

const pct = computed(() => `${((model.value - props.min) / (props.max - props.min)) * 100}%`);

function onInput(e: Event): void {
  model.value = Number((e.target as HTMLInputElement).value);
}
</script>

<template>
  <div :class="cn('relative flex h-4 items-center', $props.class)">
    <div class="absolute inset-x-0 h-1 rounded-full bg-muted">
      <div class="h-1 rounded-full bg-primary" :style="{ width: pct }"></div>
    </div>
    <div class="absolute -ml-[6.5px] size-[13px] rounded-full border-[1.5px] border-primary bg-background" :style="{ left: pct }"></div>
    <input
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="model"
      :disabled="disabled"
      class="absolute inset-0 m-0 w-full cursor-pointer opacity-0"
      @input="onInput"
    />
  </div>
</template>
