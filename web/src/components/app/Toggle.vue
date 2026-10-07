<script setup lang="ts" vapor>
import { cn } from "@/lib/utils";

defineProps<{ disabled?: boolean; label?: string }>();
const model = defineModel<boolean>({ required: true });
</script>

<template>
  <button
    type="button"
    role="switch"
    :aria-checked="model"
    :aria-label="label"
    :disabled="disabled"
    :class="cn('flex h-[18px] w-8 shrink-0 rounded-full p-[2px] transition-colors disabled:cursor-not-allowed disabled:opacity-50', model ? 'justify-end bg-primary' : 'justify-start bg-input')"
    @click="model = !model"
  >
    <span class="size-[14px] rounded-full bg-background shadow-[0_1px_2px_rgb(0_0_0/.25)]"></span>
  </button>
</template>
