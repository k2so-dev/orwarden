import { shallowRef } from "vue";

export type ToastKind = "ok" | "info" | "err";
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; title: string; desc: string; kind: ToastKind; action: ToastAction | null };

export const toasts = shallowRef<Toast[]>([]);
let seq = 0;

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function notify(title: string, desc = "", kind: ToastKind = "ok", action: ToastAction | null = null): void {
  const id = ++seq;
  toasts.value = [...toasts.value, { id, title, desc, kind, action }];
  setTimeout(() => dismiss(id), kind === "err" || action ? 9000 : 3800);
}
