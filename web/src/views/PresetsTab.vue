<script setup lang="ts" vapor>
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import PresetCard from "@/components/presets/PresetCard.vue";
import { client, unwrap } from "@/lib/api";
import { viewQuery } from "@/stores/filters";
import { act, dryRun, presets, reloadAfterWrite } from "@/stores/data";

const list = computed(() => presets.value ?? []);
const busy = ref(false);

async function syncAll() {
  busy.value = true;
  const models = list.value.filter((p) => p.status !== "empty").map((p) => p.model);
  const res = await act(() => unwrap(client.presets.sync.$post({ json: { models, scenario: viewQuery.value.scenario, dryRun: dryRun.value } })));
  busy.value = false;
  if (!res) return;
  const failed = res.filter((r) => r.status === "failed");
  if (failed.length > 0) toast.error(`${failed.length} preset(s) failed: ${failed[0]!.error ?? ""}`);
  else toast.success(dryRun.value ? `Would write ${res.filter((r) => r.status === "planned").length} preset(s)` : `${res.filter((r) => r.status === "synced").length} preset(s) saved`);
  await reloadAfterWrite();
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex min-w-80 flex-1 items-start gap-2.5 rounded-[10px] border border-border px-4 py-3 text-[13px]">
        <svg class="mt-px size-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4M12 8h.01"></path></svg>
        <div>
          Paste the preset id as the model name in any OpenAI-compatible client.
          <span class="text-muted-foreground">Each preset keeps the top endpoints that pass the quality filters, ordered from most to least efficient.</span>
        </div>
      </div>
      <button type="button" :disabled="busy" class="inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:opacity-50" @click="syncAll">
        <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"></path><path d="M21 3v5h-5"></path></svg>
        {{ dryRun ? "Preview sync all" : "Sync all presets" }}
      </button>
    </div>
    <div class="grid grid-cols-[repeat(auto-fill,minmax(520px,1fr))] gap-3">
      <PresetCard v-for="p in list" :key="p.model" :preset="p" />
    </div>
  </div>
</template>
