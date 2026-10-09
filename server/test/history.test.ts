import { describe, expect, test } from "bun:test";
import { Store } from "../src/db.ts";

const at = (day: number, hour = 0) => new Date(Date.UTC(2026, 9, 1 + day, hour)).toISOString();
const ep = (tag: string, pIn: number, pOut = 2, pCache = 0.1, quantization = "fp8") => ({ tag, pIn, pOut, pCache, quantization });
const kinds = (events: { kind: string; tag: string }[]) => events.map((e) => `${e.kind}:${e.tag}`);

describe("price events", () => {
  test("first sight of a model is a baseline, later differences are events", () => {
    const store = new Store(":memory:");
    expect(kinds(store.recordPrices(at(0), [{ slug: "m", endpoints: [ep("a", 1), ep("b", 1)] }]))).toEqual(["baseline:a", "baseline:b"]);
    expect(store.recordPrices(at(0, 1), [{ slug: "m", endpoints: [ep("a", 1), ep("b", 1)] }])).toEqual([]);
    const next = store.recordPrices(at(0, 2), [{ slug: "m", endpoints: [ep("a", 1.75), ep("c", 1)] }]);
    expect(kinds(next)).toEqual(["changed:a", "added:c", "removed:b"]);
    expect(next[0]!.pIn).toBe(1.75);
    expect(next[2]!.pIn).toBe(1);
    expect(store.endpointStates("m").map((s) => s.tag)).toEqual(["a", "c"]);
  });

  test("a quantization change counts as a change", () => {
    const store = new Store(":memory:");
    store.recordPrices(at(0), [{ slug: "m", endpoints: [ep("a", 1)] }]);
    expect(kinds(store.recordPrices(at(0, 1), [{ slug: "m", endpoints: [ep("a", 1, 2, 0.1, "fp4")] }]))).toEqual(["changed:a"]);
  });

  test("duplicate tags are tracked as separate slots", () => {
    const store = new Store(":memory:");
    store.recordPrices(at(0), [{ slug: "m", endpoints: [ep("a", 1), ep("a", 2)] }]);
    const events = store.recordPrices(at(0, 1), [{ slug: "m", endpoints: [ep("a", 1), ep("a", 3)] }]);
    expect(events.map((e) => [e.kind, e.slot, e.pIn])).toEqual([["changed", 1, 3]]);
  });

  test("models missing from a snapshot keep their state", () => {
    const store = new Store(":memory:");
    store.recordPrices(at(0), [{ slug: "m", endpoints: [ep("a", 1)] }]);
    expect(store.recordPrices(at(0, 1), [])).toEqual([]);
    expect(store.endpointStates("m")).toHaveLength(1);
  });

  test("first seen comes from older history on the first baseline", () => {
    const store = new Store(":memory:");
    store.addHistory(at(-3), [{ model: "m", tag: "a", pIn: 1, pOut: 2, pCache: 0.1, uptime: 1, tps: null }]);
    store.recordPrices(at(0), [{ slug: "m", endpoints: [ep("a", 1), ep("b", 1)] }]);
    const states = new Map(store.endpointStates("m").map((s) => [s.tag, s.firstSeen]));
    expect(states.get("a")).toBe(at(-3));
    expect(states.get("b")).toBe(at(0));
  });

  test("rotation keeps the last event before the window and drops stale endpoints", () => {
    const store = new Store(":memory:");
    store.recordPrices(at(0), [{ slug: "m", endpoints: [ep("a", 1)] }, { slug: "old", endpoints: [ep("x", 1)] }]);
    store.recordPrices(at(1), [{ slug: "m", endpoints: [ep("a", 2)] }]);
    store.recordPrices(at(2), [{ slug: "m", endpoints: [ep("a", 3)] }]);
    store.recordPrices(at(40), [{ slug: "m", endpoints: [ep("a", 3)] }]);
    const left = store.priceEvents(at(-1));
    expect(left.map((e) => [e.model, e.pIn])).toEqual([["m", 3]]);
    expect(store.endpointStates("old")).toEqual([]);
  });

  test("removed endpoints disappear after the window", () => {
    const store = new Store(":memory:");
    store.recordPrices(at(0), [{ slug: "m", endpoints: [ep("a", 1), ep("b", 1)] }]);
    store.recordPrices(at(1), [{ slug: "m", endpoints: [ep("a", 1)] }]);
    expect(kinds(store.priceEvents(at(1)))).toEqual(["removed:b"]);
    store.recordPrices(at(40), [{ slug: "m", endpoints: [ep("a", 1)] }]);
    expect(kinds(store.priceEvents(at(-1)))).toEqual(["baseline:a"]);
  });
});

describe("endpoint history", () => {
  test("stores the verdict and enables incremental vacuum", () => {
    const store = new Store(":memory:");
    store.addHistory(at(0), [{ model: "m", tag: "a", pIn: 1, pOut: 2, pCache: 0.1, uptime: 1, tps: null, verdict: "outlier" }]);
    expect(store.db.query<{ verdict: string }, []>("select verdict from endpoint_history").get()?.verdict).toBe("outlier");
    expect(store.db.query<{ auto_vacuum: number }, []>("pragma auto_vacuum").get()?.auto_vacuum).toBe(2);
  });
});
