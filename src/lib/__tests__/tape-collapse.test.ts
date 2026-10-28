import { describe, expect, it } from "vitest";
import { collapseByCoinClass, collapseForCoinNews } from "@/lib/tape-collapse";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";

let idSeq = 0;

function makeEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  idSeq += 1;
  return {
    id: `evt-${idSeq}`,
    type: "depeg.peak_worsened",
    severity: "warning" as TapeEventSeverity,
    ts: Date.UTC(2026, 0, 15, 12, 0, 0) - idSeq,
    endsAt: null,
    coinId: "usdxl-last",
    issuerId: null,
    pegCurrency: "USD",
    chain: null,
    title: "USDXL depeg peak worsened",
    summary: "USDXL drift worsened.",
    payload: {},
    sourceTable: "depeg_events",
    sourceRowId: `row-${idSeq}`,
    transition: "updated",
    sourceUrl: "/stablecoin/usdxl-last/#peg-history",
    methodologyVersion: null,
    ...overrides,
  };
}

describe("collapseByCoinClass", () => {
  it("collapses repeated same-coin same-type events", () => {
    const collapsed = collapseByCoinClass([
      makeEvent({ id: "evt-3", sourceRowId: "3" }),
      makeEvent({ id: "evt-2", sourceRowId: "2" }),
      makeEvent({ id: "evt-1", sourceRowId: "1" }),
    ]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).toMatchObject({ event: expect.objectContaining({ id: "evt-3" }), count: 3 });
  });

  it("keeps distinct same-coin class transitions visible", () => {
    const collapsed = collapseByCoinClass([
      makeEvent({ id: "evt-resolved", type: "depeg.resolved", severity: "info", transition: "resolved" }),
      makeEvent({ id: "evt-opened", type: "depeg.opened", severity: "critical", transition: "opened" }),
      makeEvent({ id: "evt-peak", type: "depeg.peak_worsened", severity: "warning", transition: "updated" }),
    ]);

    expect(collapsed.map((entry) => entry.event.id)).toEqual(["evt-resolved", "evt-opened", "evt-peak"]);
    expect(collapsed.every((entry) => entry.count === 1)).toBe(true);
  });

  it("keeps same-type severity changes visible", () => {
    const collapsed = collapseByCoinClass([
      makeEvent({ id: "evt-warning", severity: "warning" }),
      makeEvent({ id: "evt-critical", severity: "critical" }),
    ]);

    expect(collapsed.map((entry) => entry.event.id)).toEqual(["evt-warning", "evt-critical"]);
  });

  it("keeps null-coin freeze subtypes and stablecoins distinct on the same chain", () => {
    const blockedUsdt = makeEvent({
      type: "freeze.blocked",
      severity: "notice",
      coinId: null,
      chain: "Ethereum",
      payload: { stablecoin: "USDT" },
      transition: "snapshot",
    });
    const destroyedUsdc = makeEvent({
      type: "freeze.destroyed",
      severity: "critical",
      coinId: null,
      chain: "Ethereum",
      payload: { stablecoin: "USDC" },
      transition: "snapshot",
    });

    const collapsed = collapseByCoinClass([blockedUsdt, destroyedUsdc]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed.map((entry) => entry.key)).toEqual([
      "chain:Ethereum:freeze:stablecoin:USDT|type:freeze.blocked|severity:notice|transition:snapshot",
      "chain:Ethereum:freeze:stablecoin:USDC|type:freeze.destroyed|severity:critical|transition:snapshot",
    ]);
    expect(collapsed.map((entry) => entry.count)).toEqual([1, 1]);
  });

  it("still collapses repeated null-coin events for the same chain, subtype, stablecoin, and transition", () => {
    const first = makeEvent({
      type: "freeze.blocked",
      coinId: null,
      chain: "Ethereum",
      payload: { stablecoin: "USDT" },
      transition: "snapshot",
    });
    const second = makeEvent({
      type: "freeze.blocked",
      coinId: null,
      chain: "Ethereum",
      payload: { stablecoin: "USDT" },
      transition: "snapshot",
    });

    const collapsed = collapseByCoinClass([first, second]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.key).toBe(
      "chain:Ethereum:freeze:stablecoin:USDT|type:freeze.blocked|severity:warning|transition:snapshot",
    );
    expect(collapsed[0]!.count).toBe(2);
    expect(collapsed[0]!.event).toBe(first);
  });
});

function lowBand(direction: "up" | "down", overrides: Partial<TapeEvent> = {}): TapeEvent {
  return makeEvent({
    type: direction === "up" ? "dews.escalated" : "dews.deescalated",
    severity: direction === "up" ? "warning" : "info",
    coinId: "usde-ethena",
    transition: "updated",
    payload: direction === "up" ? { prevBand: "CALM", newBand: "WATCH" } : { prevBand: "WATCH", newBand: "CALM" },
    ...overrides,
  });
}

describe("collapseForCoinNews", () => {
  it("groups five same-coin reversals into one entry with directional counts and range", () => {
    const events = [
      lowBand("up", { id: "r5", ts: 5_000 }),
      lowBand("down", { id: "r4", ts: 4_000 }),
      lowBand("up", { id: "r3", ts: 3_000 }),
      lowBand("down", { id: "r2", ts: 2_000 }),
      lowBand("up", { id: "r1", ts: 1_000 }),
      makeEvent({ id: "other", ts: 500 }),
    ];
    const entries = collapseForCoinNews(events);

    expect(entries.map((entry) => entry.event.id)).toEqual(["r5", "other"]);
    expect(entries[0]!.event).toBe(events[0]);
    expect(entries[0]!.lowBand).toEqual({ calmToWatch: 3, watchToCalm: 2, oldestTs: 1_000, loadedEventCount: 6 });
    expect(entries[1]!.lowBand).toBeUndefined();
  });

  it("keeps separate coins in separate groups", () => {
    const entries = collapseForCoinNews([
      lowBand("up", { id: "a2" }),
      lowBand("up", { id: "b2", coinId: "usdc-circle" }),
      lowBand("down", { id: "a1" }),
      lowBand("down", { id: "b1", coinId: "usdc-circle" }),
    ]);

    expect(entries.map((entry) => [entry.event.id, entry.lowBand?.calmToWatch, entry.lowBand?.watchToCalm])).toEqual([
      ["a2", 1, 1],
      ["b2", 1, 1],
    ]);
  });

  it("renders a singleton as an ordinary entry and accepts empty input", () => {
    expect(collapseForCoinNews([])).toEqual([]);
    const entries = collapseForCoinNews([lowBand("up", { id: "only" }), makeEvent({ id: "other" })]);
    expect(entries.map((entry) => entry.event.id)).toEqual(["only", "other"]);
    expect(entries.every((entry) => entry.lowBand === undefined)).toBe(true);
  });

  it("keeps malformed, mismatched and serious transitions individual and in order", () => {
    const events = [
      lowBand("up", { id: "low-3" }),
      makeEvent({ id: "serious", type: "dews.escalated", payload: { prevBand: "WATCH", newBand: "ALERT" } }),
      lowBand("up", { id: "missing-payload", payload: {} }),
      lowBand("up", { id: "wrong-type", type: "dews.deescalated" }),
      lowBand("down", { id: "no-coin", coinId: null }),
      lowBand("down", { id: "low-2" }),
      makeEvent({ id: "serious-down", type: "dews.deescalated", payload: { prevBand: "ALERT", newBand: "WATCH" } }),
      lowBand("up", { id: "low-1" }),
    ];
    const entries = collapseForCoinNews(events);

    expect(entries.map((entry) => entry.event.id)).toEqual([
      "low-3",
      "serious",
      "missing-payload",
      "wrong-type",
      "no-coin",
      "serious-down",
    ]);
    expect(entries[0]!.lowBand).toMatchObject({ calmToWatch: 2, watchToCalm: 1 });
    expect(entries.slice(1).every((entry) => entry.lowBand === undefined)).toBe(true);
  });

  it("does not mutate input events", () => {
    const events = [lowBand("up"), lowBand("down")];
    const snapshot = structuredClone(events);
    collapseForCoinNews(events);
    expect(events).toEqual(snapshot);
  });

  it("collapses before the caller caps entries so older stories surface", () => {
    const reversals = Array.from({ length: 52 }, (_, i) => lowBand(i % 2 === 0 ? "up" : "down", { id: `r${i}` }));
    const others = Array.from({ length: 4 }, (_, i) => makeEvent({ id: `o${i}`, type: `score.upgraded`, transition: "updated" }));
    const visible = collapseForCoinNews([...reversals, ...others]).slice(0, 5);

    expect(visible.map((entry) => entry.event.id)).toEqual(["r0", "o0", "o1", "o2", "o3"]);
    expect(visible[0]!.lowBand).toMatchObject({ calmToWatch: 26, watchToCalm: 26, loadedEventCount: 56 });
  });
});
