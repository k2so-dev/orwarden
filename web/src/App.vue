<script setup lang="ts" vapor>
import { onMounted } from "vue";
import ConfirmDialog from "@/components/app/ConfirmDialog.vue";
import FloatTip from "@/components/app/FloatTip.vue";
import Toasts from "@/components/app/Toasts.vue";
import { authenticated, checkSession, loadAll } from "@/stores/data";
import Login from "@/views/Login.vue";
import Shell from "@/views/Shell.vue";

onMounted(async () => {
  if (await checkSession()) await loadAll();
});
</script>

<template>
  <Login v-if="authenticated === false" />
  <Shell v-else-if="authenticated === true" />
  <FloatTip />
  <Toasts />
  <ConfirmDialog />
</template>
