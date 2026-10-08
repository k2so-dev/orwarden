<script setup lang="ts" vapor>
import { computed } from "vue";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { confirmRequest, settleConfirm } from "@/stores/confirm";

const open = computed({
  get: () => confirmRequest.value !== null,
  set: (v: boolean) => {
    if (!v) settleConfirm(false);
  },
});
const btn = "h-[34px] rounded-lg px-3.5 text-[13px] font-medium";
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent class="z-[60] flex w-[440px] max-w-[calc(100vw-32px)] flex-col gap-3.5 rounded-xl p-6 sm:max-w-[440px]">
      <div>
        <AlertDialogTitle class="text-[17px] font-semibold">{{ confirmRequest?.title }}</AlertDialogTitle>
        <AlertDialogDescription class="mt-1 whitespace-pre-line text-pretty text-[13.5px] text-muted-foreground">{{ confirmRequest?.text }}</AlertDialogDescription>
      </div>
      <div class="flex justify-end gap-2">
        <button type="button" :class="[btn, 'border border-border bg-background hover:bg-accent']" @click="settleConfirm(false)">Cancel</button>
        <button type="button" :class="[btn, confirmRequest?.danger ? 'bg-bad text-white' : 'bg-primary text-primary-foreground']" @click="settleConfirm(true)">{{ confirmRequest?.action }}</button>
      </div>
    </AlertDialogContent>
  </AlertDialog>
</template>
