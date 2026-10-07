import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderState } from "./core/hysteresis.ts";

export type RunKind = "refresh" | "scheduled" | "apply" | "rollback";
export type RunStatus = "ok" | "failed";
export type Policy = "ban" | "allow";

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
  scenario: string | null;
  pinned: string[];
  excluded: string[];
  syncedHash: string | null;
  syncedAt: string | null;
};

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
create table if not exists provider_state (
  provider text primary key, auto_banned integer not null, ban_streak integer not null, clean_streak integer not null
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
};

const toPreset = (r: PresetRow): PresetSettings => ({
  model: r.model,
  slug: r.slug,
  autoSync: r.auto_sync === 1,
  scenario: r.scenario,
  pinned: JSON.parse(r.pinned),
  excluded: JSON.parse(r.excluded),
  syncedHash: r.synced_hash,
  syncedAt: r.synced_at,
});

export class Store {
  readonly db: Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
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

  addHistory(ts: string, rows: { model: string; tag: string; pIn: number; pOut: number; pCache: number; uptime: number; tps: number | null }[], keepDays = 30): void {
    this.db.transaction(() => {
      const insert = this.db.query(
        "insert into endpoint_history (ts, model, tag, p_in, p_out, p_cache, uptime, tps) values ($ts, $model, $tag, $pIn, $pOut, $pCache, $uptime, $tps)",
      );
      for (const r of rows) insert.run({ ts, ...r });
      const cutoff = new Date(Date.parse(ts) - keepDays * 86_400_000).toISOString();
      this.db.query("delete from endpoint_history where ts < ?").run(cutoff);
    })();
  }

  history(model: string, since: string): HistoryPoint[] {
    return this.db
      .query<HistoryPoint, [string, string]>(
        `select ts, tag, p_in as pIn, p_out as pOut, p_cache as pCache, uptime, tps
         from endpoint_history where model = ? and ts >= ? order by ts, tag`,
      )
      .all(model, since);
  }

  loadStates(): Map<string, ProviderState> {
    const rows = this.db
      .query<{ provider: string; auto_banned: number; ban_streak: number; clean_streak: number }, []>(
        "select * from provider_state order by provider",
      )
      .all();
    return new Map(
      rows.map((r) => [
        r.provider,
        { provider: r.provider, autoBanned: r.auto_banned === 1, banStreak: r.ban_streak, cleanStreak: r.clean_streak },
      ]),
    );
  }

  saveStates(states: ReadonlyMap<string, ProviderState>): void {
    this.db.transaction(() => {
      this.db.exec("delete from provider_state");
      const put = this.db.query(
        "insert into provider_state (provider, auto_banned, ban_streak, clean_streak) values ($provider, $auto, $ban, $clean)",
      );
      for (const s of states.values()) {
        put.run({ provider: s.provider, auto: s.autoBanned ? 1 : 0, ban: s.banStreak, clean: s.cleanStreak });
      }
    })();
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

  presetSettings(): Map<string, PresetSettings> {
    const rows = this.db.query<PresetRow, []>("select * from presets order by model").all();
    return new Map(rows.map((r) => [r.model, toPreset(r)]));
  }

  savePresetSettings(p: PresetSettings): void {
    this.db
      .query(
        `insert into presets (model, slug, auto_sync, scenario, pinned, excluded, synced_hash, synced_at)
         values ($model, $slug, $autoSync, $scenario, $pinned, $excluded, $syncedHash, $syncedAt)
         on conflict(model) do update set slug = excluded.slug, auto_sync = excluded.auto_sync, scenario = excluded.scenario,
           pinned = excluded.pinned, excluded = excluded.excluded, synced_hash = excluded.synced_hash, synced_at = excluded.synced_at`,
      )
      .run({
        model: p.model,
        slug: p.slug,
        autoSync: p.autoSync ? 1 : 0,
        scenario: p.scenario,
        pinned: JSON.stringify(p.pinned),
        excluded: JSON.stringify(p.excluded),
        syncedHash: p.syncedHash,
        syncedAt: p.syncedAt,
      });
  }

  close(): void {
    this.db.close();
  }
}
