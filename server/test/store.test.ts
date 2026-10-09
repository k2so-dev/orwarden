import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";

describe("store migration", () => {
  test("drops the auto-ban state and the allow policies, keeping manual bans", () => {
    const path = join(mkdtempSync(join(tmpdir(), "orwarden-")), "state.db");
    const old = new Database(path, { create: true });
    old.exec(`create table provider_state (provider text primary key, auto_banned integer not null, ban_streak integer not null, clean_streak integer not null);
      insert into provider_state values ('auto', 1, 0, 0);
      create table provider_policy (provider text primary key, policy text not null, updated_at text not null);
      insert into provider_policy values ('manual', 'ban', 'now'), ('kept', 'allow', 'now');`);
    old.close();
    const store = new Store(path);
    expect([...store.policies()]).toEqual([["manual", "ban"]]);
    const tables = store.db.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all().map((t) => t.name);
    expect(tables).not.toContain("provider_state");
  });
});
