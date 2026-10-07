<script setup lang="ts" vapor>
import { onMounted } from "vue";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { authenticated, checkSession, loadAll } from "@/stores/data";
import Login from "@/views/Login.vue";
import Shell from "@/views/Shell.vue";

onMounted(async () => {
  if (await checkSession()) await loadAll();
});
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <Login v-if="authenticated === false" />
    <Shell v-else-if="authenticated === true" />
  </TooltipProvider>
  <Toaster position="bottom-right" />
</template>
