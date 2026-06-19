import { describe, expect, it } from "vitest";
import { collapseByCoinClass } from "@/lib/tape-collapse";
import type { TapeEvent, TapeEventSeverity } from "@shared/types/tape-event";

let idSeq = 0;
function makeEvent(type: string, overrides: Partial<TapeEvent> = {}): TapeEvent {
  idSeq += 1;
  return {
    id: `ev-${idSeq}`,
    type,
    severity: "info" as TapeEventSeverity,
    ts: Date.UTC(2026, 4, 21, 12, 0, 0) - idSeq,
    endsAt: null,
    coinId: null,
    issuerId: null,
    pegCurrency: null,
    chain: "Ethereum",
    title: "",
    summary: "",
    payload: {},
    sourceTable: "test",
    sourceRowId: `row-${idSeq}`,
    transition: "snapshot",
    sourceUrl: null,
    methodologyVersion: null,
    ...overrides,
  };
}

describe("collapseByCoinClass", () => {
  it("keeps null-coin freeze subtypes and stablecoins distinct on the same chain", () => {
    const blockedUsdt = makeEvent("freeze.blocked", {
      severity: "notice",
      payload: { stablecoin: "USDT" },
    });
    const destroyedUsdc = makeEvent("freeze.destroyed", {
      severity: "critical",
      payload: { stablecoin: "USDC" },
    });

    const collapsed = collapseByCoinClass([blockedUsdt, destroyedUsdc]);

    expect(collapsed).toHaveLength(2);
    expect(collapsed.map((entry) => entry.key)).toEqual([
      "chain:Ethereum:freeze.blocked:stablecoin:USDT",
      "chain:Ethereum:freeze.destroyed:stablecoin:USDC",
    ]);
    expect(collapsed.map((entry) => entry.count)).toEqual([1, 1]);
  });

  it("still collapses repeated null-coin events for the same chain, subtype, and stablecoin", () => {
    const first = makeEvent("freeze.blocked", {
      payload: { stablecoin: "USDT" },
    });
    const second = makeEvent("freeze.blocked", {
      payload: { stablecoin: "USDT" },
    });

    const collapsed = collapseByCoinClass([first, second]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.key).toBe("chain:Ethereum:freeze.blocked:stablecoin:USDT");
    expect(collapsed[0]!.count).toBe(2);
    expect(collapsed[0]!.event).toBe(first);
  });

  it("preserves the existing coin-and-class collapse for attributed events", () => {
    const opened = makeEvent("depeg.opened", { coinId: "usdc", chain: null });
    const closed = makeEvent("depeg.closed", { coinId: "usdc", chain: null });

    const collapsed = collapseByCoinClass([opened, closed]);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]!.key).toBe("usdc:depeg");
    expect(collapsed[0]!.count).toBe(2);
  });
});
