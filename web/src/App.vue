<script setup lang="ts" vapor>
import { onMounted, ref } from "vue";
import { client, unwrap, type Status } from "@/lib/api";

const status = ref<Status | null>(null);
const error = ref<string | null>(null);

onMounted(async () => {
  try {
    status.value = await unwrap(client.status.$get());
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
});
</script>

<template>
  <main class="min-h-screen p-8 font-mono text-sm">
    <h1 class="mb-4 text-lg font-semibold">rerouter</h1>
    <p v-if="error" class="text-destructive">{{ error }}</p>
    <pre v-else>{{ status }}</pre>
  </main>
</template>
