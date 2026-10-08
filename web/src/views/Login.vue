<script setup lang="ts" vapor>
import { ref } from "vue";
import { RequestError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { loadAll, login } from "@/stores/data";

const password = ref("");
const failed = ref(false);
const busy = ref(false);
const text = ref("Wrong password");

async function submit(): Promise<void> {
  if (busy.value || password.value.length === 0) return;
  busy.value = true;
  failed.value = false;
  try {
    await login(password.value);
    await loadAll();
  } catch (err) {
    failed.value = true;
    text.value = err instanceof RequestError && err.status === 429 ? err.body.message : "Wrong password";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="grid min-h-screen place-items-center bg-background p-5">
    <form class="flex w-[380px] max-w-full flex-col gap-[18px] rounded-xl border border-border bg-card p-7 shadow-sm dark:bg-[oklch(0.205_0_0)]" @submit.prevent="submit">
      <div class="flex flex-col items-center gap-2.5 text-center">
        <div class="grid size-9 place-items-center rounded-[9px] bg-primary font-mono text-lg font-semibold text-primary-foreground">r</div>
        <div>
          <div class="text-xl font-semibold tracking-tight">orwarden</div>
          <div class="mt-0.5 text-[13.5px] text-muted-foreground">Sign in to manage OpenRouter providers</div>
        </div>
      </div>
      <div class="flex flex-col gap-1.5">
        <label for="password" class="text-[13px] font-medium">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          placeholder="••••••••"
          autocomplete="current-password"
          autofocus
          :class="
            cn(
              'h-9 rounded-lg border bg-background px-3 text-sm outline-none',
              failed ? 'border-bad shadow-[0_0_0_3px_var(--bad-bg)]' : 'border-border focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            )
          "
        />
        <div v-if="failed" class="flex items-center gap-1.5 text-[12.5px] text-bad">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 8v4M12 16h.01"></path>
          </svg>
          {{ text }}
        </div>
      </div>
      <button
        type="submit"
        :disabled="busy"
        class="flex h-9 items-center justify-center rounded-lg bg-primary text-sm font-medium text-primary-foreground disabled:opacity-60"
      >
        Sign in
      </button>
      <div class="text-center text-xs text-muted-foreground">Single-owner instance · password is set in the server env</div>
    </form>
  </main>
</template>
