import { describe, expect, it } from "vitest";
import { collapseByCoinClass } from "@/lib/tape-collapse";
import type { TapeEvent } from "@shared/types/tape-event";

function makeEvent(overrides: Partial<TapeEvent> = {}): TapeEvent {
  return {
    id: "evt-1",
    type: "depeg.peak_worsened",
    severity: "warning",
    ts: Date.UTC(2026, 0, 15, 12, 0, 0),
    endsAt: null,
    coinId: "usdxl-last",
    issuerId: null,
    pegCurrency: "USD",
    chain: null,
    title: "USDXL depeg peak worsened",
    summary: "USDXL drift worsened.",
    payload: {},
    sourceTable: "depeg_events",
    sourceRowId: "1",
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
});
