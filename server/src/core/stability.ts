import type { EndpointState, PriceEvent } from "../db.ts";

const DAY = 86_400_000;
export const STABILITY_WINDOW_DAYS = 30;
export const NEW_ENDPOINT_DAYS = 7;

export type Prices = { pIn: number; pOut: number; pCache: number };

export type Sample = { ts: string; uptime: number; verdict: string | null };

export type Stability = {
  score: number;
  priceTrend7d: number | null;
  priceTrend30d: number | null;
  priceChanges: number;
  lastChangeAt: string | null;
  lastChangePct: number | null;
  priceSwing: number;
  uptimeMin7d: number | null;
  uptimeDips: number;
  verdictFlaps: number;
  ageDays: number | null;
  isNew: boolean;
};

export type StabilityInput = {
  now: string;
  current: Prices;
  state: EndpointState | null;
  events: readonly PriceEvent[];
  samples: readonly Sample[];
  h: number;
  r: number;
  minUptime: number;
};

export type HistoryInputs = {
  states: ReadonlyMap<string, EndpointState>;
  events: ReadonlyMap<string, PriceEvent[]>;
  samples: ReadonlyMap<string, Sample[]>;
};

export const slotKey = (model: string, tag: string, slot: number) => `${model}\u0000${tag}\u0000${slot}`;
export const tagKey = (model: string, tag: string) => `${model}\u0000${tag}`;

export const NEUTRAL_STABILITY: Stability = {
  score: 50,
  priceTrend7d: null,
  priceTrend30d: null,
  priceChanges: 0,
  lastChangeAt: null,
  lastChangePct: null,
  priceSwing: 1,
  uptimeMin7d: null,
  uptimeDips: 0,
  verdictFlaps: 0,
  ageDays: null,
  isNew: false,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const blended = (p: Prices, h: number, r: number) => (1 - h) * p.pIn + h * p.pCache + r * p.pOut;

export function computeStability(input: StabilityInput): Stability {
  const now = Date.parse(input.now);
  const since30 = now - STABILITY_WINDOW_DAYS * DAY;
  const since7 = now - NEW_ENDPOINT_DAYS * DAY;
  const cost = (p: Prices) => blended(p, input.h, input.r);
  const priced = input.events.filter((e) => e.kind !== "removed");
  const priceAt = (t: number): number | null => {
    let found: PriceEvent | null = null;
    for (const e of priced) if (Date.parse(e.ts) <= t) found = e;
    return found ? cost(found) : null;
  };
  const nowCost = cost(input.current);
  const trend = (t: number) => {
    const then = priceAt(t);
    return then !== null && then > 0 ? nowCost / then - 1 : null;
  };

  const inWindow = priced.filter((e) => Date.parse(e.ts) >= since30);
  const changes = inWindow.filter((e) => e.kind === "changed");
  const last = changes.at(-1) ?? null;
  const beforeLast = last ? priced.slice(0, priced.indexOf(last)).at(-1) : undefined;
  const lastChangePct = last && beforeLast && cost(beforeLast) > 0 ? cost(last) / cost(beforeLast) - 1 : null;
  const start = priceAt(since30);
  const values = [...(start === null ? [] : [start]), ...inWindow.map(cost), nowCost].filter((v) => v > 0);
  const priceSwing = values.length > 1 ? Math.max(...values) / Math.min(...values) : 1;

  const recent = input.samples.filter((s) => Date.parse(s.ts) >= since30);
  const week = recent.filter((s) => Date.parse(s.ts) >= since7);
  const uptimeMin7d = week.length > 0 ? Math.min(...week.map((s) => s.uptime)) : null;
  const uptimeDips = new Set(recent.filter((s) => s.uptime < input.minUptime).map((s) => s.ts.slice(0, 10))).size;
  let verdictFlaps = 0;
  let prev: string | null = null;
  for (const s of recent) {
    if (s.verdict === null) continue;
    if (prev !== null && s.verdict !== prev) verdictFlaps++;
    prev = s.verdict;
  }

  const ageDays = input.state ? Math.max(0, (now - Date.parse(input.state.firstSeen)) / DAY) : null;
  const priceScore = clamp(100 - 200 * (priceSwing - 1) - 5 * Math.min(changes.length, 5), 0, 100);
  const uptimeScore = clamp(100 - 15 * uptimeDips - 5 * verdictFlaps, 0, 100);
  const confidence = ageDays === null ? 0 : Math.min(ageDays / NEW_ENDPOINT_DAYS, 1);
  const score = 50 + ((priceScore + uptimeScore) / 2 - 50) * confidence;

  return {
    score: Math.round(score * 10) / 10,
    priceTrend7d: trend(since7),
    priceTrend30d: trend(since30),
    priceChanges: changes.length,
    lastChangeAt: last?.ts ?? null,
    lastChangePct,
    priceSwing,
    uptimeMin7d,
    uptimeDips,
    verdictFlaps,
    ageDays,
    isNew: ageDays !== null && ageDays < NEW_ENDPOINT_DAYS,
  };
}

export function endpointStability(
  history: HistoryInputs | undefined,
  model: string,
  endpoints: readonly (Prices & { tag: string })[],
  now: string,
  profile: { h: number; r: number },
  minUptime: number,
): Stability[] {
  if (!history) return endpoints.map(() => NEUTRAL_STABILITY);
  const slots = new Map<string, number>();
  return endpoints.map((e) => {
    const slot = slots.get(e.tag) ?? 0;
    slots.set(e.tag, slot + 1);
    const key = slotKey(model, e.tag, slot);
    return computeStability({
      now,
      current: e,
      state: history.states.get(key) ?? null,
      events: history.events.get(key) ?? [],
      samples: history.samples.get(tagKey(model, e.tag)) ?? [],
      h: profile.h,
      r: profile.r,
      minUptime,
    });
  });
}
