import { describe, expect, it } from "vitest";
import type { TelegramRecapScopedFact } from "../telegram/recap-ranking";
import { collapseTelegramRecapFacts, selectTelegramRecapFacts } from "../telegram/recap-ranking";

function fact(overrides: Partial<TelegramRecapScopedFact> = {}): TelegramRecapScopedFact {
  return {
    eventId: "event-a",
    type: "depeg.opened",
    family: "depeg",
    severity: "warning",
    ts: 100,
    coinId: "usdc-circle",
    symbol: "USDC",
    name: "USD Coin",
    chain: null,
    payload: { direction: "below", absDeviationBps: 250 },
    membership: "direct",
    ...overrides,
  };
}

describe("Telegram recap ranking", () => {
  it("collapses an open-and-resolved depeg into its lifecycle resolution", () => {
    const collapsed = collapseTelegramRecapFacts([
      fact({ eventId: "open", ts: 100 }),
      fact({ eventId: "worse", type: "depeg.peak_worsened", ts: 200, payload: { direction: "below", absDeviationBps: 500 } }),
      fact({ eventId: "resolved", type: "depeg.resolved", severity: "info", ts: 300 }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.type).toBe("depeg.resolved");
  });

  it("uses severity, transition, membership, time, then event id ordering", () => {
    const selected = selectTelegramRecapFacts([
      fact({ eventId: "z", coinId: "usdt-tether", symbol: "USDT", membership: "global", ts: 500 }),
      fact({ eventId: "b", coinId: "dai-makerdao", symbol: "DAI", membership: "direct", ts: 400 }),
      fact({ eventId: "a", coinId: "frax-frax", symbol: "FRAX", membership: "direct", ts: 400 }),
      fact({ eventId: "critical", coinId: "usdc-circle", severity: "critical", ts: 1 }),
    ]);
    expect(selected.facts.map((entry) => entry.eventId)).toEqual(["critical", "a", "b", "z"]);
  });

  it("prioritizes adverse transitions before membership and time", () => {
    const selected = selectTelegramRecapFacts([
      fact({ eventId: "recovery", type: "score.upgraded", family: "score", membership: "direct", ts: 900 }),
      fact({ eventId: "adverse", type: "score.downgraded", family: "score", coinId: "other", membership: "global", ts: 1 }),
    ]);
    expect(selected.facts.map((entry) => entry.eventId)).toEqual(["adverse", "recovery"]);
  });

  it("orders direct before preset before global, then newest before event id", () => {
    const selected = selectTelegramRecapFacts([
      fact({ eventId: "a-old", coinId: "old", ts: 10 }),
      fact({ eventId: "z-new", coinId: "new", ts: 20 }),
      fact({ eventId: "preset", coinId: "preset", membership: "preset", ts: 100 }),
      fact({ eventId: "global", coinId: "global", membership: "global", ts: 200 }),
    ]);
    expect(selected.facts.map((entry) => entry.eventId)).toEqual(["z-new", "a-old", "preset", "global"]);
  });

  it("retains the greatest depeg magnitude rather than the newest observation", () => {
    expect(collapseTelegramRecapFacts([
      fact({ eventId: "peak", type: "depeg.peak_worsened", ts: 1, payload: { absDeviationBps: 500 } }),
      fact({ eventId: "newest", ts: 900 }),
    ]).map((entry) => entry.eventId)).toEqual(["peak"]);
  });

  it("caps new coins but admits later facts for selected coins and groups their output", () => {
    const selected = selectTelegramRecapFacts([
      ...Array.from({ length: 9 }, (_, index) => fact({
        eventId: `coin-${index}`, coinId: `coin-${index}`, ts: 100 - index,
      })),
      fact({ eventId: "later", coinId: "coin-0", type: "score.downgraded", family: "score", ts: 1 }),
    ]);
    expect(selected.facts.map((entry) => entry.eventId)).toEqual([
      "coin-0", "later", "coin-1", "coin-2", "coin-3", "coin-4", "coin-5", "coin-6", "coin-7",
    ]);
    expect(selected.omittedFactCount).toBe(1);
  });

  it("caps facts independently while below the coin cap", () => {
    const input = Array.from({ length: 14 }, (_, index) => fact({
      eventId: `event-${index}`,
      type: index % 2 === 0 ? "score.downgraded" : "yield.pys_dropped",
      family: index % 2 === 0 ? "score" : "yield",
      coinId: `coin-${Math.floor(index / 2)}`,
      ts: 1_000 - index,
    }));
    const selected = selectTelegramRecapFacts(input);
    expect(selected.facts.map((entry) => entry.eventId)).toEqual(
      Array.from({ length: 12 }, (_, index) => `event-${index}`),
    );
    expect([...new Set(selected.facts.map((entry) => entry.coinId))]).toEqual([
      "coin-0", "coin-1", "coin-2", "coin-3", "coin-4", "coin-5",
    ]);
    expect(selected.omittedFactCount).toBe(2);
  });
});
