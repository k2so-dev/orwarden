import { computed, ref, shallowRef, watch } from "vue";
import { refDebounced } from "@vueuse/core";
import {
  client,
  RequestError,
  unwrap,
  type BanHistory,
  type HistoryPoint,
  type Overview,
  type PresetView,
  type ProvidersView,
  type Settings,
  type Status,
} from "@/lib/api";
import { viewQuery } from "./filters";
import { notify } from "./toast";

export const authenticated = ref<boolean | null>(null);
export const status = shallowRef<Status | null>(null);
export const settings = shallowRef<Settings | null>(null);
export const overview = shallowRef<Overview | null>(null);
export const providers = shallowRef<ProvidersView | null>(null);
export const presets = shallowRef<PresetView[] | null>(null);
export const history = shallowRef<BanHistory>([]);
export const loading = ref(false);
export const refreshing = ref(false);
export const loadError = ref<string | null>(null);

export const dryRun = computed(() => (settings.value?.mode ?? "dry-run") === "dry-run");
export const hasData = computed(() => status.value !== null && status.value.takenAt !== null);

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function checkSession(): Promise<boolean> {
  const res = await unwrap(client.auth.session.$get());
  authenticated.value = res.authenticated;
  return res.authenticated;
}

export async function login(password: string): Promise<void> {
  await unwrap(client.auth.login.$post({ json: { password } }));
  authenticated.value = true;
}

export async function logout(): Promise<void> {
  await unwrap(client.auth.logout.$post());
  authenticated.value = false;
  status.value = null;
  overview.value = null;
  providers.value = null;
  presets.value = null;
}

export async function loadStatus(): Promise<void> {
  status.value = await unwrap(client.status.$get());
}

export async function loadSettings(): Promise<void> {
  settings.value = await unwrap(client.settings.$get());
}

async function guard<T>(task: () => Promise<T>): Promise<T | null> {
  try {
    return await task();
  } catch (err) {
    if (err instanceof RequestError && err.status === 401) {
      authenticated.value = false;
      return null;
    }
    if (err instanceof RequestError && err.body.error === "no-data") return null;
    loadError.value = message(err);
    return null;
  }
}

export async function loadViews(): Promise<void> {
  if (!hasData.value) return;
  const query = viewQuery.value;
  const [o, p, pr, h] = await Promise.all([
    guard(() => unwrap(client.overview.$get({ query }))),
    guard(() => unwrap(client.providers.$get({ query }))),
    guard(() => unwrap(client.presets.$get({ query: { ...query, fresh: "false" } }))),
    guard(() => unwrap(client.bans.history.$get({ query: { limit: "30" } }))),
  ]);
  if (o) overview.value = o;
  if (p) providers.value = p;
  if (pr) presets.value = pr;
  if (h) history.value = h;
}

export async function loadAll(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  await Promise.all([guard(loadStatus), guard(loadSettings)]);
  await loadViews();
  loading.value = false;
}

export async function reloadAfterWrite(): Promise<void> {
  await guard(loadStatus);
  await loadViews();
}

export async function refreshNow(full = false): Promise<void> {
  refreshing.value = true;
  let ok = false;
  try {
    await unwrap(client.refresh.$post({ json: { full } }));
    ok = true;
  } catch (err) {
    notify("Refresh failed", message(err), "err");
  } finally {
    await reloadAfterWrite();
    refreshing.value = false;
  }
  if (ok) notify(full ? "Full cycle finished" : "Data refreshed", dataSummary());
}

const debounced = refDebounced(viewQuery, 250);
watch(debounced, () => {
  if (authenticated.value) void loadViews();
});

export function dataSummary(): string {
  const models = overview.value?.models ?? [];
  const endpoints = models.reduce((n, m) => n + m.endpoints.length, 0);
  return `${providers.value?.rows.length ?? 0} providers · ${models.length} models · ${endpoints} endpoints`;
}

export async function act<T>(task: () => Promise<T>, success?: string, desc?: string | ((result: T) => string)): Promise<T | null> {
  try {
    const result = await task();
    if (success) notify(success, typeof desc === "function" ? desc(result) : (desc ?? ""));
    return result;
  } catch (err) {
    notify("Write failed", message(err), "err");
    return null;
  }
}

export function previewOnly(): void {
  notify("Preview only", "Dry-run: nothing was written to OpenRouter.", "info");
}

export const historyCache = shallowRef<ReadonlyMap<string, HistoryPoint[]>>(new Map());
const historyPending = new Set<string>();

export async function ensureHistory(model: string): Promise<void> {
  if (historyCache.value.has(model) || historyPending.has(model)) return;
  historyPending.add(model);
  const points = await guard(() => unwrap(client.history.$get({ query: { model, days: "7" } })));
  historyPending.delete(model);
  if (points) historyCache.value = new Map(historyCache.value).set(model, points);
}
