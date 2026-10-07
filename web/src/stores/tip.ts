import { shallowRef } from "vue";
import type { TipLine } from "@/lib/issues";

export type TipState = { title: string; lines: TipLine[]; x: number; y: number };

export const tip = shallowRef<TipState | null>(null);

export function showTip(e: Event, title: string, lines: TipLine[]): void {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  tip.value = { title, lines, x: Math.round(Math.max(8, Math.min(r.left, window.innerWidth - 340))), y: Math.round(r.bottom + 6) };
}

export function hideTip(): void {
  if (tip.value) tip.value = null;
}
