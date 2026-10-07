<script setup lang="ts" vapor>
import { computed } from "vue";
import { cn } from "@/lib/utils";

export type BadgeKind = "ok" | "warn" | "bad" | "mute" | "out" | "none";

const KINDS: Record<BadgeKind, string> = {
  ok: "bg-ok-bg text-ok",
  warn: "bg-warn-bg text-warn",
  bad: "bg-bad-bg text-bad",
  mute: "bg-muted text-muted-foreground",
  out: "border border-border text-foreground",
  none: "text-muted-foreground",
};

const props = withDefaults(defineProps<{ kind: BadgeKind; mono?: boolean; class?: string }>(), { mono: false, class: "" });

const classes = computed(() =>
  cn(
    "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-md px-[7px] text-[11px] font-medium",
    KINDS[props.kind],
    props.mono && "font-mono",
    props.class,
  ),
);
</script>

<template>
  <span :class="classes"><slot /></span>
</template>
