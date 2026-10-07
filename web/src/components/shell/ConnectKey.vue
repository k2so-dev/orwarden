<script setup lang="ts" vapor>
import { ref } from "vue";
import { client, unwrap } from "@/lib/api";
import { cn } from "@/lib/utils";
import { loadAll, message, refreshNow } from "@/stores/data";

const key = ref("");
const show = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

async function connect(): Promise<void> {
  if (busy.value || key.value.trim().length === 0) return;
  busy.value = true;
  error.value = null;
  try {
    await unwrap(client.key.$put({ json: { key: key.value.trim() } }));
    key.value = "";
    await loadAll();
    await refreshNow(false);
  } catch (err) {
    error.value = message(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="grid min-h-[calc(100vh-56px)] place-items-center px-5 py-10">
    <form class="flex w-[440px] max-w-full flex-col gap-3.5 rounded-xl border border-border bg-card p-6 shadow-sm" @submit.prevent="connect">
      <div class="grid size-9 place-items-center rounded-[9px] bg-muted">
        <svg class="size-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="7.5" cy="15.5" r="5.5"></circle>
          <path d="m21 2-9.6 9.6"></path>
          <path d="m15.5 7.5 3 3L22 7l-3-3"></path>
        </svg>
      </div>
      <div>
        <div class="text-lg font-semibold tracking-tight">Connect OpenRouter</div>
        <div class="mt-1 text-pretty text-[13.5px] text-muted-foreground">
          rerouter needs a management key to read provider data and write guardrails and presets. It is stored encrypted on this server.
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <label for="mgmt-key" class="text-[13px] font-medium">Management key</label>
        <div class="relative">
          <input
            id="mgmt-key"
            v-model="key"
            :type="show ? 'text' : 'password'"
            placeholder="sk-or-v1-…"
            autocomplete="off"
            spellcheck="false"
            :class="cn('h-9 w-full rounded-lg border bg-background pl-3 pr-10 font-mono text-[13px] outline-none', error ? 'border-bad' : 'border-border focus-visible:ring-[3px] focus-visible:ring-ring/50')"
          />
          <button type="button" class="absolute right-1 top-1 grid size-7 place-items-center text-muted-foreground" @click="show = !show">
            <svg class="size-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
        </div>
        <div v-if="error" class="text-[12.5px] text-bad">{{ error }}</div>
        <a href="https://openrouter.ai/settings/management-keys" target="_blank" rel="noreferrer" class="text-[12.5px] text-muted-foreground hover:text-foreground">
          Where do I create a management key? ↗
        </a>
      </div>
      <button
        type="submit"
        :disabled="busy"
        class="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary text-[13.5px] font-medium text-primary-foreground disabled:opacity-60"
      >
        <svg v-if="busy" class="size-[15px] animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"></path>
        </svg>
        {{ busy ? "Verifying key…" : "Connect" }}
      </button>
    </form>
  </main>
</template>
