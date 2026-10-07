import { describe, expect, test } from "bun:test";
import { applyHysteresis, autoSet, type ProviderState } from "../src/core/hysteresis.ts";
import { testConfig } from "./helpers.ts";

const config = testConfig();
const flat = () => 1;
const step = (prev: Map<string, ProviderState>, target: string[]) =>
  applyHysteresis(prev, new Set(target), flat, config);

describe("hysteresis", () => {
  test("a single failing run does not ban", () => {
    const r1 = step(new Map(), ["bad"]);
    expect(r1.changes).toEqual([]);
    expect(autoSet(r1.states).size).toBe(0);
    const r2 = step(r1.states, []);
    expect(r2.changes).toEqual([]);
    const r3 = step(r2.states, ["bad"]);
    expect(r3.changes).toEqual([]);
  });

  test("bans after two consecutive runs", () => {
    const r1 = step(new Map(), ["bad"]);
    const r2 = step(r1.states, ["bad"]);
    expect(r2.changes).toEqual([{ provider: "bad", action: "ban" }]);
    expect(autoSet(r2.states)).toEqual(new Set(["bad"]));
  });

  test("unbans after three clean runs", () => {
    let states = new Map([["bad", { provider: "bad", autoBanned: true, banStreak: 0, cleanStreak: 0 }]]);
    for (let i = 0; i < 2; i++) {
      const r = step(states, []);
      expect(r.changes).toEqual([]);
      states = r.states;
    }
    const r = step(states, []);
    expect(r.changes).toEqual([{ provider: "bad", action: "unban" }]);
    expect(autoSet(r.states).size).toBe(0);
  });

  test("a relapse resets the clean streak", () => {
    let states = new Map([["bad", { provider: "bad", autoBanned: true, banStreak: 0, cleanStreak: 0 }]]);
    states = step(states, []).states;
    states = step(states, []).states;
    states = step(states, ["bad"]).states;
    const r = step(states, []);
    expect(r.changes).toEqual([]);
  });

  test("caps changes per run and prioritises by impact", () => {
    const names = ["a", "b", "c", "d", "e"];
    const impact = (p: string) => names.indexOf(p) + 1;
    const r1 = applyHysteresis(new Map(), new Set(names), impact, config);
    const r2 = applyHysteresis(r1.states, new Set(names), impact, config);
    expect(r2.changes.map((c) => c.provider)).toEqual(["e", "d", "c"]);
    expect(r2.pending.filter((p) => p.capped).map((p) => p.provider)).toEqual(["b", "a"]);
    const r3 = applyHysteresis(r2.states, new Set(names), impact, config);
    expect(r3.changes.map((c) => c.provider)).toEqual(["b", "a"]);
  });
});
