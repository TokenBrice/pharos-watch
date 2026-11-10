import { describe, expect, it } from "vitest";
import {
  evaluateReserveCompositionCensus,
  parseReserveCompositionCensusState,
  summarizeReserveCompositionCensus,
} from "../live-reserves/reserve-composition-census";

const COIN = "iusd-infinifi";

function slices(entries: Array<[string, number, string?]>) {
  return entries.map(([name, pct, sourceKey]) => ({ name, pct, ...(sourceKey ? { sourceKey } : {}) }));
}

describe("reserve composition census", () => {
  it("keys the census by sourceKey when present and aggregates duplicate identities", () => {
    expect(summarizeReserveCompositionCensus(slices([
      ["T-bills", 40, "treasury:us-tbill"],
      ["T-bill ladder", 10, "treasury:us-tbill"],
      ["Custody cash", 50],
    ]))).toEqual({
      census: ["Custody cash", "treasury:us-tbill"],
      shares: { "treasury:us-tbill": 50, "Custody cash": 50 },
    });
  });

  it("seeds a baseline on the first observation and reports nothing", () => {
    const result = evaluateReserveCompositionCensus(
      new Map([[COIN, slices([["T-bills", 100]])]]),
      { version: 1, coins: {} },
    );
    expect(result.observedCoins).toBe(1);
    expect(result.findings).toEqual([]);
    expect(result.state.coins[COIN]).toEqual({ census: ["T-bills"], shares: { "T-bills": 100 } });
  });

  it("flags added and removed slice identities", () => {
    const previous = evaluateReserveCompositionCensus(
      new Map([[COIN, slices([["T-bills", 100]])]]),
      { version: 1, coins: {} },
    ).state;
    const result = evaluateReserveCompositionCensus(
      new Map([[COIN, slices([["T-bills", 70], ["Repo", 30]])]]),
      previous,
    );
    expect(result.findings).toEqual([{
      stablecoinId: COIN,
      added: ["Repo"],
      removed: [],
      shareDriftPct: 30,
    }]);
  });

  it("flags a share-vector move only above the shared total-variation budget", () => {
    const previous = evaluateReserveCompositionCensus(
      new Map([[COIN, slices([["T-bills", 60], ["Custody cash", 40]])]]),
      { version: 1, coins: {} },
    ).state;

    const atBudget = evaluateReserveCompositionCensus(
      new Map([[COIN, slices([["T-bills", 50], ["Custody cash", 50]])]]),
      previous,
    );
    expect(atBudget.findings).toEqual([]);

    const overBudget = evaluateReserveCompositionCensus(
      new Map([[COIN, slices([["T-bills", 49], ["Custody cash", 51]])]]),
      previous,
    );
    expect(overBudget.findings).toEqual([{
      stablecoinId: COIN,
      added: [],
      removed: [],
      shareDriftPct: 11,
    }]);
  });

  it("keeps a baseline for a coin absent from this run", () => {
    const previous = evaluateReserveCompositionCensus(
      new Map([[COIN, slices([["T-bills", 100]])]]),
      { version: 1, coins: {} },
    ).state;
    const result = evaluateReserveCompositionCensus(new Map(), previous);
    expect(result.observedCoins).toBe(0);
    expect(result.findings).toEqual([]);
    expect(result.state.coins[COIN]).toEqual(previous.coins[COIN]);
  });

  it("parses only well-formed retained state", () => {
    expect(parseReserveCompositionCensusState(null)).toEqual({ state: { version: 1, coins: {} }, issue: null });
    expect(parseReserveCompositionCensusState(JSON.stringify({ coins: {
      [COIN]: { census: ["T-bills"], shares: { "T-bills": 100 } },
    } }))).toEqual({
      state: { version: 1, coins: { [COIN]: { census: ["T-bills"], shares: { "T-bills": 100 } } } },
      issue: null,
    });
  });

  it("reports unreadable or self-inconsistent retained state as unknown, never an empty baseline", () => {
    expect(parseReserveCompositionCensusState("not-json")).toEqual({ state: null, issue: "invalid-json" });
    // A census identity without a share (or the reverse) would fabricate an
    // added/removed slice on the next diff.
    expect(parseReserveCompositionCensusState(JSON.stringify({ coins: {
      [COIN]: { census: ["T-bills"], shares: {} },
    } }))).toEqual({ state: null, issue: "invalid-state" });
    expect(parseReserveCompositionCensusState(JSON.stringify({ coins: {
      [COIN]: { census: ["T-bills"], shares: ["T-bills"] },
    } }))).toEqual({ state: null, issue: "invalid-state" });
    expect(parseReserveCompositionCensusState(JSON.stringify({ coins: {
      [COIN]: { census: [], shares: {} },
      bad: { census: ["x"], shares: { x: "nope" } },
    } }))).toEqual({ state: null, issue: "invalid-state" });
  });
});
