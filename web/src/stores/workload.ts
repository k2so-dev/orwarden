import { computed } from "vue";
import { client, unwrap, type Settings } from "@/lib/api";
import { act, message, reloadAfterWrite, settings } from "./data";
import { DEFAULT_WEIGHTS, KINDS, kindOf, localView } from "./filters";
import { notify } from "./toast";

export type ViewPatch = Partial<{
  actual: boolean;
  cache: number;
  ratio: number;
  tools: boolean;
  volumeM: number;
  minQuant: string;
  zdrOnly: boolean;
  minUptime: number;
  weights: { price: number; speed: number; reliability: number };
}>;

export const view = computed(() => {
  const s = settings.value;
  return {
    actual: (s?.workload.mode ?? "actual") === "actual",
    cache: s?.workload.h ?? 0.5,
    ratio: s?.workload.r ?? 0.3,
    tools: s?.filters.requireTools ?? false,
    volumeM: (s?.workload.tokensPerDay ?? 1_000_000) / 1_000_000,
    minQuant: s?.filters.minQuantization ?? "fp8",
    zdrOnly: s?.filters.zdrOnly ?? false,
    minUptime: Number(((s?.filters.minUptime ?? 0.97) * 100).toFixed(4)),
    weights: { price: s?.scoring.price ?? DEFAULT_WEIGHTS.price, speed: s?.scoring.speed ?? DEFAULT_WEIGHTS.speed, reliability: s?.scoring.reliability ?? DEFAULT_WEIGHTS.reliability },
    days: localView.value.days,
    hideBanned: localView.value.hideBanned,
  };
});

export const uptimeFloor = computed(() => Math.min(90, Math.floor(view.value.minUptime)));

export function workloadLabel(): string {
  const v = view.value;
  if (v.actual) return "Actual traffic";
  return `${KINDS[kindOf(v.cache, v.ratio)].label} · cache ${Math.round(v.cache * 100)}% · out/in ${Number(v.ratio.toFixed(2))}${v.tools ? " · tools" : ""}`;
}

function apply(s: Settings, p: ViewPatch): Settings {
  return {
    ...s,
    workload: {
      mode: p.actual === undefined ? s.workload.mode : p.actual ? "actual" : "custom",
      h: p.cache ?? s.workload.h,
      r: p.ratio ?? s.workload.r,
      tokensPerDay: p.volumeM === undefined ? s.workload.tokensPerDay : Math.round(p.volumeM * 1_000_000),
    },
    filters: {
      ...s.filters,
      requireTools: p.tools ?? s.filters.requireTools,
      minQuantization: p.minQuant ?? s.filters.minQuantization,
      zdrOnly: p.zdrOnly ?? s.filters.zdrOnly,
      minUptime: p.minUptime === undefined ? s.filters.minUptime : p.minUptime / 100,
    },
    scoring: { ...s.scoring, ...p.weights },
  };
}

function body(s: Settings) {
  return {
    workload: s.workload,
    filters: { requireTools: s.filters.requireTools, minQuantization: s.filters.minQuantization, zdrOnly: s.filters.zdrOnly, minUptime: s.filters.minUptime },
    scoring: { price: s.scoring.price, speed: s.scoring.speed, reliability: s.scoring.reliability },
  };
}

let base: Settings | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight: Promise<void> = Promise.resolve();

async function put(next: Settings): Promise<Settings | null> {
  return act(() => unwrap(client.settings.$put({ json: body(next) })));
}

async function flush(): Promise<void> {
  const before = base;
  const current = settings.value;
  base = null;
  if (!before || !current) return;
  const res = await put(current);
  if (!res) {
    settings.value = before;
    return;
  }
  settings.value = res;
  await reloadAfterWrite();
  notify("Saved", "Presets, auto-sync and scheduled bans use these rules", "ok", {
    label: "Undo",
    run: () => void undo(before),
  });
}

async function undo(before: Settings): Promise<void> {
  const s = settings.value;
  if (!s) return;
  const restored = apply(s, {
    actual: before.workload.mode === "actual",
    cache: before.workload.h,
    ratio: before.workload.r,
    volumeM: before.workload.tokensPerDay / 1_000_000,
    tools: before.filters.requireTools,
    minQuant: before.filters.minQuantization,
    zdrOnly: before.filters.zdrOnly,
    minUptime: before.filters.minUptime * 100,
    weights: { price: before.scoring.price, speed: before.scoring.speed, reliability: before.scoring.reliability },
  });
  settings.value = restored;
  const res = await put(restored);
  if (res) settings.value = res;
  else notify("Undo failed", message("could not restore the previous rules"), "err");
  await reloadAfterWrite();
}

export function updateView(patch: ViewPatch): void {
  const s = settings.value;
  if (!s) return;
  base ??= s;
  settings.value = apply(s, patch);
  clearTimeout(timer);
  timer = setTimeout(() => {
    inflight = inflight.then(flush);
  }, 500);
}
