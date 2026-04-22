import { describe, expect, it } from "vitest";
import { buildLiveReportCards } from "../report-cards-snapshot-card";
import type { PegSummaryCoin } from "@shared/types/market";

describe("buildLiveReportCards variant activeDepeg cascade", () => {
  it("resolves a wrapper's activeDepegBps against its parent when peg is inherited", () => {
    const now = Math.floor(Date.now() / 1000);

    const parentPeg: PegSummaryCoin = {
      id: "usds-sky",
      symbol: "USDS",
      name: "Sky USD",
      pegType: "USD",
      pegCurrency: "USD",
      governance: "centralized-dependent",
      currentDeviationBps: -2800,
      pegScore: 40,
      pegPct: 0.972,
      severityScore: 60,
      spreadPenalty: 0,
      worstDeviationBps: 2800,
      activeDepeg: true,
      eventCount: 1,
      lastEventAt: now - 3600,
      trackingSpanDays: 30,
      methodologyVersion: "test",
    };

    // Wrapper has no peg entry of its own; the snapshot path should fall back
    // to the parent's peg summary because `pegReferenceId === variantOf`.
    const pegDataById = new Map<string, PegSummaryCoin>([["usds-sky", parentPeg]]);
    const activeDepegPeakBpsById = new Map<string, number>([["usds-sky", 2800]]);

    const cards = buildLiveReportCards({
      pegDataById,
      activeDepegPeakBpsById,
      dexLiqMap: {},
      redemptionBackstopMap: {},
      bluechipMap: {},
      resolvedBlacklistStatuses: new Map(),
      liveReserveMap: new Map(),
    });

    const variantCard = cards.find((card) => card.id === "susds-sky");
    expect(variantCard).toBeDefined();
    expect(variantCard?.rawInputs.activeDepeg).toBe(true);
    expect(variantCard?.rawInputs.activeDepegBps).toBe(2800);
  });

  it("records activeDepegBps as null on the wrapper when the parent is not currently depegged", () => {
    const parentPeg: PegSummaryCoin = {
      id: "usds-sky",
      symbol: "USDS",
      name: "Sky USD",
      pegType: "USD",
      pegCurrency: "USD",
      governance: "centralized-dependent",
      currentDeviationBps: 0,
      pegScore: 90,
      pegPct: 1,
      severityScore: 95,
      spreadPenalty: 0,
      worstDeviationBps: null,
      activeDepeg: false,
      eventCount: 0,
      lastEventAt: null,
      trackingSpanDays: 30,
      methodologyVersion: "test",
    };

    const pegDataById = new Map<string, PegSummaryCoin>([["usds-sky", parentPeg]]);
    const activeDepegPeakBpsById = new Map<string, number>();

    const cards = buildLiveReportCards({
      pegDataById,
      activeDepegPeakBpsById,
      dexLiqMap: {},
      redemptionBackstopMap: {},
      bluechipMap: {},
      resolvedBlacklistStatuses: new Map(),
      liveReserveMap: new Map(),
    });

    const variantCard = cards.find((card) => card.id === "susds-sky");
    expect(variantCard?.rawInputs.activeDepeg).toBe(false);
    expect(variantCard?.rawInputs.activeDepegBps).toBeNull();
  });
});
