import { computed, ref } from "vue";

export const TABS = ["models", "providers"] as const;
export type Tab = (typeof TABS)[number];

const path = ref(window.location.pathname);

window.addEventListener("popstate", () => {
  path.value = window.location.pathname;
});

export const tab = computed<Tab>(() => {
  const seg = path.value.split("/")[1] as Tab;
  return TABS.includes(seg) ? seg : "models";
});

export function go(next: Tab): void {
  const target = `/${next}`;
  if (window.location.pathname !== target) window.history.pushState(null, "", target);
  path.value = target;
}
