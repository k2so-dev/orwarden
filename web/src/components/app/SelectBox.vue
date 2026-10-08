<script setup lang="ts" vapor>
defineProps<{ options: readonly { value: string; label: string }[] }>();
const model = defineModel<string>({ required: true });

function change(e: Event) {
  model.value = (e.target as HTMLSelectElement).value;
}
</script>

<template>
  <span class="relative inline-flex">
    <select
      class="h-8 w-full appearance-none rounded-lg border border-border bg-background pl-2.5 pr-7 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      @change="change"
    >
      <option v-for="o in options" :key="o.value" :value="o.value" :selected="o.value === model">{{ o.label }}</option>
    </select>
    <svg class="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="m6 9 6 6 6-6"></path>
    </svg>
  </span>
</template>
