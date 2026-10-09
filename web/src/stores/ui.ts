import { useStorage } from "@vueuse/core";
import { ref, shallowRef, watchEffect } from "vue";

export const clock = shallowRef(new Date());
setInterval(() => (clock.value = new Date()), 30_000);

export const theme = useStorage<"light" | "dark">("rr-theme", "light");
export const density = useStorage<"compact" | "comfortable">("rr-density", "compact");
export const columns = useStorage("rr-columns", { zt: true, lat: true, share: true, brk: true, stab: true }, localStorage, { mergeDefaults: true });
export const settingsOpen = ref(false);
export type SortState = { key: string; dir: "asc" | "desc" };

export const modelOpen = shallowRef<ReadonlyMap<string, boolean>>(new Map());
export const openRows = shallowRef<ReadonlySet<string>>(new Set());
export const sortStates = shallowRef<ReadonlyMap<string, SortState>>(new Map());
export const DEFAULT_SORT: SortState = { key: "rank", dir: "asc" };

watchEffect(() => {
  document.documentElement.classList.toggle("dark", theme.value === "dark");
});

export function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
}

export function setModelOpen(slug: string, open: boolean): void {
  modelOpen.value = new Map(modelOpen.value).set(slug, open);
}

export function toggleIn(source: typeof openRows, key: string): void {
  const next = new Set(source.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  source.value = next;
}

const ASC_FIRST = new Set(["rank", "in", "out", "cache", "om", "lat", "perM", "hz", "vs", "trend"]);

export function sortBy(model: string, key: string): void {
  const s = sortStates.value.get(model) ?? DEFAULT_SORT;
  const next: SortState = s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: ASC_FIRST.has(key) ? "asc" : "desc" };
  sortStates.value = new Map(sortStates.value).set(model, next);
}
