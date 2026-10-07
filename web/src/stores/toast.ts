import { shallowRef } from "vue";

export type ToastKind = "ok" | "info" | "err";
export type Toast = { id: number; title: string; desc: string; kind: ToastKind };

export const toasts = shallowRef<Toast[]>([]);
let seq = 0;

export function notify(title: string, desc = "", kind: ToastKind = "ok"): void {
  const id = ++seq;
  toasts.value = [...toasts.value, { id, title, desc, kind }];
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 3800);
}
