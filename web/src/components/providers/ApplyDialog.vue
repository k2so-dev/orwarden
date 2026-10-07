<script setup lang="ts" vapor>
import { computed } from "vue";
import type { ApplyResult } from "@/lib/api";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

const props = defineProps<{ plan: ApplyResult | null; dryRun: boolean; busy: boolean }>();
const emit = defineEmits<{ confirm: [] }>();
const open = defineModel<boolean>("open", { required: true });

const changed = computed(() => (props.plan?.added.length ?? 0) + (props.plan?.removed.length ?? 0) > 0);
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent class="max-w-[480px]">
      <AlertDialogHeader>
        <AlertDialogTitle>{{ dryRun ? "Preview guardrail changes" : "Apply to guardrail" }}</AlertDialogTitle>
        <AlertDialogDescription>
          {{ dryRun ? "Dry-run mode: nothing is written to OpenRouter." : "These changes are written to the workspace default guardrail and affect every request." }}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div v-if="plan" class="flex flex-col gap-1 rounded-lg border border-border bg-muted/50 p-3 font-mono text-[12.5px]">
        <div v-for="p in plan.added" :key="'a' + p" class="text-bad">+ {{ p }}</div>
        <div v-for="p in plan.removed" :key="'r' + p" class="text-ok">− {{ p }}</div>
        <div v-if="!changed" class="font-sans text-muted-foreground">No changes.</div>
      </div>
      <div v-if="plan && changed" class="text-[13px] text-muted-foreground">
        Banned providers after apply: <b class="font-semibold text-foreground">{{ plan.after.length }}</b> (was {{ plan.before.length }}).
      </div>
      <div v-for="r in plan?.reverted ?? []" :key="r.provider" class="rounded-lg bg-warn-bg px-3 py-2 text-[13px]">
        Skipped ban of {{ r.provider }}: {{ r.slug }} would keep {{ r.admissible }}/{{ r.required }} good endpoints.
      </div>
      <div v-for="v in plan?.unresolved ?? []" :key="v.slug" class="rounded-lg bg-warn-bg px-3 py-2 text-[13px]">
        {{ v.slug }} has {{ v.admissible }}/{{ v.required }} good endpoints.
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel>{{ dryRun ? "Close" : "Cancel" }}</AlertDialogCancel>
        <Button v-if="!dryRun" :disabled="busy || !changed" @click="emit('confirm')">Apply to guardrail</Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
