<script setup lang="ts" vapor>
import { cn } from "@/lib/utils";

withDefaults(defineProps<{ options: { value: string; label: string }[]; size?: "sm" | "md"; class?: string }>(), { size: "md", class: "" });
const model = defineModel<string>({ required: true });
</script>

<template>
  <div :class="cn('flex gap-[2px] rounded-lg bg-muted p-[3px]', $props.class)" role="group">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      :class="
        cn(
          'whitespace-nowrap rounded-md px-[10px] font-medium transition-colors',
          size === 'sm' ? 'h-6 text-xs' : 'h-[26px] text-[12.5px]',
          model === o.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
        )
      "
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>
