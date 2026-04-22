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
      pegScore: 40,
      pegScoreDetail: "test",
      activeDepeg: true,
      latestDeviationBps: -2800,
      eventCount: 1,
      lastEventAt: now - 3600,
      samples: 0,
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
      pegScore: 90,
      pegScoreDetail: "test",
      activeDepeg: false,
      latestDeviationBps: 0,
      eventCount: 0,
      lastEventAt: null,
      samples: 0,
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
