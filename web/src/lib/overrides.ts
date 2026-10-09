import type { ModelOverrides } from "@/lib/api";

export function overrideLabels(o: ModelOverrides): string[] {
  const out: string[] = [];
  if (o.workload) out.push(o.workload.mode === "actual" ? "actual traffic" : `cache ${Math.round(o.workload.h * 100)}% · out/in ${Number(o.workload.r.toFixed(2))} · ${Number((o.workload.tokensPerDay / 1_000_000).toFixed(2))}M in/day`);
  if (o.requireTools !== undefined) out.push(o.requireTools ? "tools required" : "tools optional");
  if (o.minQuantization !== undefined) out.push(`${o.minQuantization}+`);
  if (o.minUptime !== undefined) out.push(`uptime ≥${Number((o.minUptime * 100).toFixed(2))}%`);
  if (o.zdrOnly !== undefined) out.push(o.zdrOnly ? "ZDR only" : "ZDR optional");
  if (o.scoring) out.push(`weights ${o.scoring.price} / ${o.scoring.speed} / ${o.scoring.reliability} / ${o.scoring.stability}`);
  if (o.topN !== undefined) out.push(`top ${o.topN}`);
  return out;
}
