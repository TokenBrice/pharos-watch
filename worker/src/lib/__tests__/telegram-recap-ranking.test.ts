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

  it("enforces the fact and coin caps with a deterministic omitted count", () => {
    const input = Array.from({ length: 14 }, (_, index) => fact({
      eventId: `event-${index}`,
      type: index % 2 === 0 ? "score.downgraded" : "yield.pys_dropped",
      family: index % 2 === 0 ? "score" : "yield",
      coinId: `coin-${Math.floor(index / 2)}`,
      ts: 1_000 - index,
    }));
    const selected = selectTelegramRecapFacts(input);
    expect(selected.facts).toHaveLength(12);
    expect(selected.omittedFactCount).toBe(2);
  });
});
