import type { PriceEvent } from "../db.ts";
import type { Prices } from "./stability.ts";

export const CHANGE_THRESHOLD = 0.1;

export type PriceChange = {
  ts: string;
  model: string;
  tag: string;
  slot: number;
  kind: "added" | "changed" | "removed";
  prices: Prices;
  prev: Prices | null;
  quantization: string;
  prevQuantization: string | null;
  inPct: number | null;
  outPct: number | null;
  blendedPct: number | null;
};

const ratio = (now: number, then: number) => (then > 0 ? now / then - 1 : null);
const blended = (p: Prices, h: number, r: number) => (1 - h) * p.pIn + h * p.pCache + r * p.pOut;

export function priceChanges(events: readonly PriceEvent[], profileOf: (model: string) => { h: number; r: number }): PriceChange[] {
  const last = new Map<string, PriceEvent>();
  const out: PriceChange[] = [];
  for (const e of [...events].sort((a, b) => a.ts.localeCompare(b.ts))) {
    const key = `${e.model}\u0000${e.tag}\u0000${e.slot}`;
    const before = last.get(key) ?? null;
    last.set(key, e);
    if (e.kind === "baseline") continue;
    const prev = e.kind === "added" || !before ? null : before;
    const { h, r } = profileOf(e.model);
    out.push({
      ts: e.ts,
      model: e.model,
      tag: e.tag,
      slot: e.slot,
      kind: e.kind,
      prices: { pIn: e.pIn, pOut: e.pOut, pCache: e.pCache },
      prev: prev && { pIn: prev.pIn, pOut: prev.pOut, pCache: prev.pCache },
      quantization: e.quantization,
      prevQuantization: prev?.quantization ?? null,
      inPct: prev && e.kind === "changed" ? ratio(e.pIn, prev.pIn) : null,
      outPct: prev && e.kind === "changed" ? ratio(e.pOut, prev.pOut) : null,
      blendedPct: prev && e.kind === "changed" ? ratio(blended(e, h, r), blended(prev, h, r)) : null,
    });
  }
  return out.reverse();
}

export function isSignificant(c: PriceChange, threshold = CHANGE_THRESHOLD): boolean {
  if (c.kind !== "changed") return true;
  if (c.prevQuantization !== null && c.prevQuantization !== c.quantization) return true;
  return Math.abs(c.blendedPct ?? 0) >= threshold || Math.abs(c.outPct ?? 0) >= threshold;
}

const signed = (v: number | null) => (v === null ? "?" : `${v >= 0 ? "+" : "−"}${Math.round(Math.abs(v) * 100)}%`);
const num = (v: number) => Number(v.toFixed(4)).toString();

export function changeLine(c: PriceChange): string {
  if (c.kind === "added") return `${c.model}: ${c.tag} added (in ${num(c.prices.pIn)}, out ${num(c.prices.pOut)})`;
  if (c.kind === "removed") return `${c.model}: ${c.tag} removed`;
  const parts = [`in ${num(c.prev!.pIn)}→${num(c.prices.pIn)}`, `out ${num(c.prev!.pOut)}→${num(c.prices.pOut)}`];
  if (c.prevQuantization !== c.quantization) parts.push(`${c.prevQuantization}→${c.quantization}`);
  return `${c.model}: ${c.tag} ${signed(c.blendedPct)} at your workload (${parts.join(", ")})`;
}
