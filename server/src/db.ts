import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelOverrides } from "./settings.ts";

export type RunKind = "refresh" | "scheduled" | "apply" | "rollback";
export type RunStatus = "ok" | "failed";
export type Policy = "ban";

export type RunRecord = {
  id: number;
  startedAt: string;
  kind: RunKind;
  mode: string;
  status: RunStatus;
  ignoredBefore: string[];
  ignoredAfter: string[];
  patched: boolean;
  error: string | null;
};

export type Decision = { provider: string; action: string; reason: string; delta: number | null };

export type PresetSettings = {
  model: string;
  slug: string | null;
  autoSync: boolean;
  pinned: string[];
  excluded: string[];
  picked: string[] | null;
  overrides: ModelOverrides;
  syncedHash: string | null;
  syncedAt: string | null;
};

export const HISTORY_DAYS = 30;

export type PriceKind = "baseline" | "added" | "changed" | "removed";

export type PricedEndpoint = { tag: string; pIn: number; pOut: number; pCache: number; quantization: string };

export type PriceEvent = PricedEndpoint & { ts: string; model: string; slot: number; kind: PriceKind };
export type Hold = { model: string; tag: string; since: string; checkedAt: string; overpayUsd: number };

export type EndpointState = PricedEndpoint & { model: string; slot: number; firstSeen: string; lastSeen: string };

export type DailyPoint = { tag: string; day: string; uptimeMin: number; uptimeAvg: number; tps: number | null };

export type HistoryPoint = {
  ts: string;
  tag: string;
  pIn: number;
  pOut: number;
  pCache: number;
  uptime: number;
  tps: number | null;
};

const SCHEMA = `
create table if not exists kv (key text primary key, value text not null);
create table if not exists secrets (name text primary key, iv text not null, data text not null);
create table if not exists snapshots (id integer primary key autoincrement, taken_at text not null, data text not null);
create table if not exists endpoint_history (
  ts text not null, model text not null, tag text not null,
  p_in real not null, p_out real not null, p_cache real not null, uptime real not null, tps real
);
create index if not exists endpoint_history_model on endpoint_history (model, ts);
create table if not exists price_events (
  ts text not null, model text not null, tag text not null, slot integer not null, kind text not null,
  p_in real not null, p_out real not null, p_cache real not null, quantization text not null
);
create index if not exists price_events_model on price_events (model, ts);
create table if not exists endpoint_state (
  model text not null, tag text not null, slot integer not null,
  p_in real not null, p_out real not null, p_cache real not null, quantization text not null,
  first_seen text not null, last_seen text not null,
  primary key (model, tag, slot)
);
create table if not exists provider_policy (provider text primary key, policy text not null, updated_at text not null);
create table if not exists runs (
  id integer primary key autoincrement,
  started_at text not null,
  kind text not null,
  mode text not null,
  status text not null,
  ignored_before text not null default '[]',
  ignored_after text not null default '[]',
  patched integer not null default 0,
  error text
);
create table if not exists decisions (
  run_id integer not null references runs(id), provider text not null, action text not null, reason text not null, delta real
);
create table if not exists preset_holds (
  model text not null, tag text not null, since text not null, checked_at text not null, overpay_usd real not null default 0,
  primary key (model, tag)
);
create table if not exists presets (
  model text primary key,
  slug text,
  auto_sync integer not null default 0,
  scenario text,
  pinned text not null default '[]',
  excluded text not null default '[]',
  synced_hash text,
  synced_at text
);
`;

type RunRow = {
  id: number;
  started_at: string;
  kind: RunKind;
  mode: string;
  status: RunStatus;
  ignored_before: string;
  ignored_after: string;
  patched: number;
  error: string | null;
};

const toRun = (r: RunRow): RunRecord => ({
  id: r.id,
  startedAt: r.started_at,
  kind: r.kind,
  mode: r.mode,
  status: r.status,
  ignoredBefore: JSON.parse(r.ignored_before),
  ignoredAfter: JSON.parse(r.ignored_after),
  patched: r.patched === 1,
  error: r.error,
});

type PresetRow = {
  model: string;
  slug: string | null;
  auto_sync: number;
  scenario: string | null;
  pinned: string;
  excluded: string;
  synced_hash: string | null;
  synced_at: string | null;
  overrides: string;
};

const PICKED = "picked";

const toPreset = (r: PresetRow): PresetSettings => ({
  model: r.model,
  slug: r.slug,
  autoSync: r.auto_sync === 1,
  pinned: r.scenario === PICKED ? [] : JSON.parse(r.pinned),
  picked: r.scenario === PICKED ? JSON.parse(r.pinned) : null,
  excluded: JSON.parse(r.excluded),
  overrides: JSON.parse(r.overrides),
  syncedHash: r.synced_hash,
  syncedAt: r.synced_at,
});

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    if (this.db.query<{ auto_vacuum: number }, []>("pragma auto_vacuum").get()?.auto_vacuum !== 2) {
      this.db.exec("pragma auto_vacuum = incremental;");
      this.db.exec("vacuum;");
    }
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
    const columns = this.db.query<{ name: string }, []>("pragma table_info(endpoint_history)").all();
    if (!columns.some((c) => c.name === "verdict")) this.db.exec("alter table endpoint_history add column verdict text;");
    const presetColumns = this.db.query<{ name: string }, []>("pragma table_info(presets)").all();
    if (!presetColumns.some((c) => c.name === "overrides")) this.db.exec("alter table presets add column overrides text not null default '{}';");
    this.db.exec("drop table if exists provider_state;");
    this.db.exec("delete from provider_policy where policy <> 'ban';");
  }

  getValue<T>(key: string): T | null {
    const row = this.db.query<{ value: string }, [string]>("select value from kv where key = ?").get(key);
    return row ? (JSON.parse(row.value) as T) : null;
  }

  setValue(key: string, value: unknown): void {
    this.db
      .query("insert into kv (key, value) values ($key, $value) on conflict(key) do update set value = excluded.value")
      .run({ key, value: JSON.stringify(value) });
  }

  getSecret(name: string): { iv: string; data: string } | null {
    return this.db.query<{ iv: string; data: string }, [string]>("select iv, data from secrets where name = ?").get(name);
  }

  setSecret(name: string, iv: string, data: string): void {
    this.db
      .query("insert into secrets (name, iv, data) values ($name, $iv, $data) on conflict(name) do update set iv = excluded.iv, data = excluded.data")
      .run({ name, iv, data });
  }

  deleteSecret(name: string): void {
    this.db.query("delete from secrets where name = ?").run(name);
  }

  saveSnapshot<T extends { takenAt: string }>(snapshot: T, keep = 48): void {
    this.db.transaction(() => {
      this.db.query("insert into snapshots (taken_at, data) values ($takenAt, $data)").run({
        takenAt: snapshot.takenAt,
        data: JSON.stringify(snapshot),
      });
      this.db.query("delete from snapshots where id not in (select id from snapshots order by id desc limit ?)").run(keep);
    })();
  }

  latestSnapshot<T>(): T | null {
    const row = this.db.query<{ data: string }, []>("select data from snapshots order by id desc limit 1").get();
    return row ? (JSON.parse(row.data) as T) : null;
  }

  addHistory(
    ts: string,
    rows: { model: string; tag: string; pIn: number; pOut: number; pCache: number; uptime: number; tps: number | null; verdict?: string | null }[],
    keepDays = HISTORY_DAYS,
  ): void {
    this.db.transaction(() => {
      const insert = this.db.query(
        "insert into endpoint_history (ts, model, tag, p_in, p_out, p_cache, uptime, tps, verdict) values ($ts, $model, $tag, $pIn, $pOut, $pCache, $uptime, $tps, $verdict)",
      );
      for (const r of rows) insert.run({ ts, ...r, verdict: r.verdict ?? null });
      const cutoff = new Date(Date.parse(ts) - keepDays * 86_400_000).toISOString();
      this.db.query("delete from endpoint_history where ts < ?").run(cutoff);
    })();
    this.db.exec("pragma incremental_vacuum;");
  }

  recordPrices(ts: string, models: { slug: string; endpoints: PricedEndpoint[] }[], keepDays = HISTORY_DAYS): PriceEvent[] {
    const events: PriceEvent[] = [];
    this.db.transaction(() => {
      const insert = this.db.query(
        "insert into price_events (ts, model, tag, slot, kind, p_in, p_out, p_cache, quantization) values ($ts, $model, $tag, $slot, $kind, $pIn, $pOut, $pCache, $quantization)",
      );
      const upsert = this.db.query(
        `insert into endpoint_state (model, tag, slot, p_in, p_out, p_cache, quantization, first_seen, last_seen)
         values ($model, $tag, $slot, $pIn, $pOut, $pCache, $quantization, $firstSeen, $ts)
         on conflict(model, tag, slot) do update set p_in = excluded.p_in, p_out = excluded.p_out, p_cache = excluded.p_cache,
           quantization = excluded.quantization, last_seen = excluded.last_seen`,
      );
      const firstHistory = this.db.query<{ ts: string | null }, [string, string]>("select min(ts) as ts from endpoint_history where model = ? and tag = ?");
      const emit = (e: Omit<PriceEvent, "ts">) => {
        insert.run({ ts, model: e.model, tag: e.tag, slot: e.slot, kind: e.kind, pIn: e.pIn, pOut: e.pOut, pCache: e.pCache, quantization: e.quantization });
        events.push({ ...e, ts });
      };
      for (const m of models) {
        const known = new Map(this.endpointStates(m.slug).map((s) => [`${s.tag}\u0000${s.slot}`, s]));
        const fresh = known.size === 0;
        const slots = new Map<string, number>();
        for (const e of m.endpoints) {
          const slot = slots.get(e.tag) ?? 0;
          slots.set(e.tag, slot + 1);
          const key = `${e.tag}\u0000${slot}`;
          const prev = known.get(key);
          known.delete(key);
          const row = { model: m.slug, tag: e.tag, slot, pIn: e.pIn, pOut: e.pOut, pCache: e.pCache, quantization: e.quantization };
          if (!prev) emit({ ...row, kind: fresh ? "baseline" : "added" });
          else if (prev.pIn !== e.pIn || prev.pOut !== e.pOut || prev.pCache !== e.pCache || prev.quantization !== e.quantization) emit({ ...row, kind: "changed" });
          const firstSeen = prev?.firstSeen ?? (fresh ? (firstHistory.get(m.slug, e.tag)?.ts ?? ts) : ts);
          upsert.run({ ...row, firstSeen: firstSeen < ts ? firstSeen : ts, ts });
        }
        for (const gone of known.values()) {
          emit({ model: m.slug, tag: gone.tag, slot: gone.slot, kind: "removed", pIn: gone.pIn, pOut: gone.pOut, pCache: gone.pCache, quantization: gone.quantization });
          this.db.query("delete from endpoint_state where model = ? and tag = ? and slot = ?").run(m.slug, gone.tag, gone.slot);
        }
      }
      const cutoff = new Date(Date.parse(ts) - keepDays * 86_400_000).toISOString();
      this.db.query("delete from endpoint_state where last_seen < ?").run(cutoff);
      this.db
        .query(
          `delete from price_events where ts < $cutoff and (
             rowid not in (select max(rowid) from price_events where ts < $cutoff group by model, tag, slot)
             or not exists (select 1 from endpoint_state s where s.model = price_events.model and s.tag = price_events.tag and s.slot = price_events.slot)
           )`,
        )
        .run({ cutoff });
    })();
    return events;
  }

  historySamples(since: string): { model: string; tag: string; ts: string; uptime: number; verdict: string | null }[] {
    return this.db
      .query<{ model: string; tag: string; ts: string; uptime: number; verdict: string | null }, [string]>(
        "select model, tag, ts, uptime, verdict from endpoint_history where ts >= ? order by ts",
      )
      .all(since);
  }

  dailyHistory(model: string, since: string): DailyPoint[] {
    return this.db
      .query<DailyPoint, [string, string]>(
        `select tag, substr(ts, 1, 10) as day, min(uptime) as uptimeMin, avg(uptime) as uptimeAvg, avg(tps) as tps
         from endpoint_history where model = ? and ts >= ? group by tag, day order by day, tag`,
      )
      .all(model, since);
  }

  endpointStates(model?: string): EndpointState[] {
    const sql = `select model, tag, slot, p_in as pIn, p_out as pOut, p_cache as pCache, quantization, first_seen as firstSeen, last_seen as lastSeen
                 from endpoint_state ${model === undefined ? "" : "where model = ?"} order by model, tag, slot`;
    return model === undefined ? this.db.query<EndpointState, []>(sql).all() : this.db.query<EndpointState, [string]>(sql).all(model);
  }

  priceEvents(since: string, model?: string): PriceEvent[] {
    const sql = `select ts, model, tag, slot, kind, p_in as pIn, p_out as pOut, p_cache as pCache, quantization
                 from price_events where ts >= ? ${model === undefined ? "" : "and model = ?"} order by ts, model, tag, slot`;
    return model === undefined ? this.db.query<PriceEvent, [string]>(sql).all(since) : this.db.query<PriceEvent, [string, string]>(sql).all(since, model);
  }

  history(model: string, since: string): HistoryPoint[] {
    return this.db
      .query<HistoryPoint, [string, string]>(
        `select ts, tag, p_in as pIn, p_out as pOut, p_cache as pCache, uptime, tps
         from endpoint_history where model = ? and ts >= ? order by ts, tag`,
      )
      .all(model, since);
  }

  policies(): Map<string, Policy> {
    const rows = this.db.query<{ provider: string; policy: Policy }, []>("select provider, policy from provider_policy").all();
    return new Map(rows.map((r) => [r.provider, r.policy]));
  }

  setPolicy(provider: string, policy: Policy | null, now: string): void {
    if (policy === null) {
      this.db.query("delete from provider_policy where provider = ?").run(provider);
      return;
    }
    this.db
      .query(
        `insert into provider_policy (provider, policy, updated_at) values ($provider, $policy, $now)
         on conflict(provider) do update set policy = excluded.policy, updated_at = excluded.updated_at`,
      )
      .run({ provider, policy, now });
  }

  replaceBanPolicies(bans: string[], now: string): void {
    this.db.transaction(() => {
      this.db.query("delete from provider_policy where policy = 'ban'").run();
      for (const p of bans) this.setPolicy(p, "ban", now);
    })();
  }

  saveRun(run: Omit<RunRecord, "id">, decisions: Decision[] = []): number {
    return this.db.transaction(() => {
      const { id } = this.db
        .query<{ id: number }, Record<string, string | number | null>>(
          `insert into runs (started_at, kind, mode, status, ignored_before, ignored_after, patched, error)
           values ($startedAt, $kind, $mode, $status, $ignoredBefore, $ignoredAfter, $patched, $error) returning id`,
        )
        .get({
          startedAt: run.startedAt,
          kind: run.kind,
          mode: run.mode,
          status: run.status,
          ignoredBefore: JSON.stringify(run.ignoredBefore),
          ignoredAfter: JSON.stringify(run.ignoredAfter),
          patched: run.patched ? 1 : 0,
          error: run.error,
        })!;
      const insert = this.db.query(
        "insert into decisions (run_id, provider, action, reason, delta) values ($id, $provider, $action, $reason, $delta)",
      );
      for (const d of decisions) insert.run({ id, ...d });
      return id;
    })();
  }

  getRun(id: number): RunRecord | null {
    const row = this.db.query<RunRow, [number]>("select * from runs where id = ?").get(id);
    return row ? toRun(row) : null;
  }

  recentRuns(limit: number, patchedOnly = false): RunRecord[] {
    return this.db
      .query<RunRow, [number]>(`select * from runs ${patchedOnly ? "where patched = 1" : ""} order by id desc limit ?`)
      .all(limit)
      .map(toRun);
  }

  decisionsFor(runId: number): Decision[] {
    return this.db
      .query<Decision, [number]>("select provider, action, reason, delta from decisions where run_id = ? order by rowid")
      .all(runId);
  }

  holds(): Map<string, Hold[]> {
    const rows = this.db
      .query<Hold, []>("select model, tag, since, checked_at as checkedAt, overpay_usd as overpayUsd from preset_holds order by model, since, tag")
      .all();
    const out = new Map<string, Hold[]>();
    for (const r of rows) out.set(r.model, [...(out.get(r.model) ?? []), r]);
    return out;
  }

  replaceHolds(model: string, holds: readonly Hold[]): void {
    this.db.transaction(() => {
      this.db.query("delete from preset_holds where model = ?").run(model);
      const insert = this.db.query("insert into preset_holds (model, tag, since, checked_at, overpay_usd) values (?, ?, ?, ?, ?)");
      for (const h of holds) insert.run(model, h.tag, h.since, h.checkedAt, h.overpayUsd);
    })();
  }

  presetSettings(): Map<string, PresetSettings> {
    const rows = this.db.query<PresetRow, []>("select * from presets order by model").all();
    return new Map(rows.map((r) => [r.model, toPreset(r)]));
  }

  savePresetSettings(p: PresetSettings): void {
    this.db
      .query(
        `insert into presets (model, slug, auto_sync, scenario, pinned, excluded, overrides, synced_hash, synced_at)
         values ($model, $slug, $autoSync, $scenario, $pinned, $excluded, $overrides, $syncedHash, $syncedAt)
         on conflict(model) do update set slug = excluded.slug, auto_sync = excluded.auto_sync, scenario = excluded.scenario,
           pinned = excluded.pinned, excluded = excluded.excluded, overrides = excluded.overrides, synced_hash = excluded.synced_hash, synced_at = excluded.synced_at`,
      )
      .run({
        model: p.model,
        slug: p.slug,
        autoSync: p.autoSync ? 1 : 0,
        scenario: p.picked ? PICKED : null,
        pinned: JSON.stringify(p.picked ?? p.pinned),
        excluded: JSON.stringify(p.excluded),
        overrides: JSON.stringify(p.overrides ?? {}),
        syncedHash: p.syncedHash,
        syncedAt: p.syncedAt,
      });
  }

  close(): void {
    this.db.close();
  }
}
