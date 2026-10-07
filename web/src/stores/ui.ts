import { useStorage } from "@vueuse/core";
import { ref, shallowRef, watchEffect } from "vue";

export const theme = useStorage<"light" | "dark">("rr-theme", "light");
export const density = useStorage<"compact" | "comfortable">("rr-density", "compact");
export const columns = useStorage("rr-columns", { zt: true, lat: true, share: true, brk: true });
export const settingsOpen = ref(false);
export const openModels = shallowRef<ReadonlySet<string>>(new Set());
export const openRows = shallowRef<ReadonlySet<string>>(new Set());
export const sortState = shallowRef<{ key: string; dir: "asc" | "desc" }>({ key: "rank", dir: "asc" });

watchEffect(() => {
  document.documentElement.classList.toggle("dark", theme.value === "dark");
});

export function toggleTheme(): void {
  theme.value = theme.value === "dark" ? "light" : "dark";
}

export function toggleIn(source: typeof openModels, key: string): void {
  const next = new Set(source.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  source.value = next;
}

export function sortBy(key: string): void {
  const s = sortState.value;
  sortState.value = s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "rank" ? "asc" : "desc" };
}
