import { describe, expect, it } from "vitest";
import { collapseByCoinClass } from "@/lib/tape-collapse";
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
