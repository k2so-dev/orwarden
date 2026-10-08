<script setup lang="ts" vapor>
import { computed } from "vue";
import type { ApplyResult } from "@/lib/api";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { periodLabel, signedMoney } from "@/lib/format";
import { status } from "@/stores/data";
import { filters, scenarioLabel } from "@/stores/filters";

const props = defineProps<{ plan: ApplyResult | null; dryRun: boolean; busy: boolean }>();
const emit = defineEmits<{ confirm: [] }>();
const open = defineModel<boolean>("open", { required: true });

const workspace = computed(() => status.value?.workspace?.name ?? "this workspace");

const effect = computed(() => {
  const p = props.plan;
  if (!p) return "";
  const c = p.cost;
  const money = c.blocked ? "leaves a model with no provider" : signedMoney(c.after - c.before);
  return `${p.added.length} added · ${p.removed.length} removed · ${money} / ${periodLabel(c.days)} across selected models (${scenarioLabel(filters.value.scenario).toLowerCase()})`;
});

type Line = { key: string; sign: string; text: string; cls: string };
const lines = computed<Line[]>(() => {
  const p = props.plan;
  if (!p) return [];
  const before = new Set(p.before);
  const after = [...p.after].sort();
  const removed = [...p.removed].sort();
  return [
    { key: "open", sign: " ", text: "{", cls: "" },
    { key: "list", sign: " ", text: '  "ignored_providers": [', cls: "" },
    ...after.map((x, i) => ({
      key: `a:${x}`,
      sign: before.has(x) ? " " : "+",
      text: `    "${x}"${i < after.length - 1 ? "," : ""}`,
      cls: before.has(x) ? "" : "bg-bad-bg text-bad",
    })),
    ...removed.map((x) => ({ key: `r:${x}`, sign: "−", text: `    "${x}"`, cls: "bg-ok-bg text-ok" })),
    { key: "end", sign: " ", text: "  ]", cls: "" },
    { key: "close", sign: " ", text: "}", cls: "" },
  ];
});

const btn = "h-[34px] rounded-lg px-3.5 text-[13px] font-medium";
</script>

<template>
  <AlertDialog v-model:open="open">
    <AlertDialogContent class="flex w-[560px] max-w-[calc(100vw-32px)] flex-col gap-3.5 rounded-xl p-6 sm:max-w-[560px]">
      <div>
        <AlertDialogTitle class="text-[17px] font-semibold">{{ dryRun ? "Preview guardrail changes" : "Apply to guardrail" }}</AlertDialogTitle>
        <AlertDialogDescription class="mt-1 text-[13.5px] text-muted-foreground">
          This replaces the guardrail's provider blacklist for every app in {{ workspace }}.
        </AlertDialogDescription>
      </div>
      <div class="tnum text-[12.5px]">{{ effect }}</div>
      <div class="overflow-auto rounded-lg border border-border bg-muted py-2.5 font-mono text-[12.5px] leading-[1.65]">
        <div v-for="l in lines" :key="l.key" :class="['flex px-3', l.cls]">
          <span class="w-4 flex-none">{{ l.sign }}</span>
          <span class="whitespace-pre">{{ l.text }}</span>
        </div>
      </div>
      <div v-for="r in plan?.reverted ?? []" :key="r.provider" class="rounded-lg bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
        Skipped ban of {{ r.provider }}: {{ r.slug }} would keep {{ r.admissible }} of {{ r.required }} good endpoints.
      </div>
      <div v-for="v in plan?.unresolved ?? []" :key="v.slug" class="rounded-lg bg-warn-bg px-3 py-2 text-[12.5px] text-warn">
        {{ v.slug }} keeps only {{ v.admissible }} of {{ v.required }} good endpoints.
      </div>
      <div v-if="dryRun" class="rounded-lg bg-warn-bg px-3 py-[9px] text-[12.5px] text-warn">
        Dry-run is on — nothing will be written. Switch to Apply in the header to write this diff.
      </div>
      <div class="flex justify-end gap-2">
        <button type="button" :class="[btn, 'border border-border bg-background hover:bg-accent']" @click="open = false">Cancel</button>
        <button
          type="button"
          :disabled="busy || (!dryRun && plan !== null && plan.added.length + plan.removed.length === 0)"
          :class="[btn, 'bg-primary text-primary-foreground disabled:opacity-50']"
          @click="emit('confirm')"
        >
          {{ dryRun ? "Close preview" : "Apply to guardrail" }}
        </button>
      </div>
    </AlertDialogContent>
  </AlertDialog>
</template>
