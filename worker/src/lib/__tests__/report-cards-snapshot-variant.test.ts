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

    const { cards } = buildLiveReportCards({
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

    const { cards } = buildLiveReportCards({
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

  it("ignores a NAV wrapper's own appreciating share price when a peg reference exists", () => {
    const fxUsdPeg: PegSummaryCoin = {
      id: "fxusd-f-x-protocol",
      symbol: "fxUSD",
      name: "fxUSD",
      pegType: "USD",
      pegCurrency: "USD",
      governance: "centralized-dependent",
      currentDeviationBps: 8,
      pegScore: 94,
      pegPct: 1.0008,
      severityScore: 96,
      spreadPenalty: 0,
      worstDeviationBps: null,
      activeDepeg: false,
      eventCount: 0,
      lastEventAt: null,
      trackingSpanDays: 30,
      methodologyVersion: "test",
    };
    const fxSaveNavPrice: PegSummaryCoin = {
      ...fxUsdPeg,
      id: "fxsave-f-x-protocol",
      symbol: "fxSAVE",
      name: "f(x) USD Saving",
      currentDeviationBps: 1096,
      pegScore: 35,
      pegPct: 1.1096,
      severityScore: 20,
      worstDeviationBps: 1096,
      activeDepeg: true,
      eventCount: 1,
    };

    const { cards } = buildLiveReportCards({
      pegDataById: new Map<string, PegSummaryCoin>([
        ["fxusd-f-x-protocol", fxUsdPeg],
        ["fxsave-f-x-protocol", fxSaveNavPrice],
      ]),
      activeDepegPeakBpsById: new Map<string, number>([["fxsave-f-x-protocol", 1096]]),
      dexLiqMap: {},
      redemptionBackstopMap: {},
      bluechipMap: {},
      resolvedBlacklistStatuses: new Map(),
      liveReserveMap: new Map(),
    });

    const variantCard = cards.find((card) => card.id === "fxsave-f-x-protocol");
    expect(variantCard?.rawInputs.pegScore).toBe(94);
    expect(variantCard?.rawInputs.activeDepeg).toBe(false);
    expect(variantCard?.rawInputs.activeDepegBps).toBeNull();
    expect(variantCard?.dimensions.pegStability.detail).toContain("Peg reference (fxUSD)");
  });

  it("derives tracked wrapper decentralization from the parent asset score", () => {
    const { cards } = buildLiveReportCards({
      pegDataById: new Map(),
      activeDepegPeakBpsById: new Map(),
      dexLiqMap: {},
      redemptionBackstopMap: {},
      bluechipMap: {},
      resolvedBlacklistStatuses: new Map(),
      liveReserveMap: new Map(),
    });

    const cardById = new Map(cards.map((card) => [card.id, card]));
    const bold = cardById.get("bold-liquity");
    const ybold = cardById.get("ybold-yearn");
    const sbold = cardById.get("sbold-k3-capital");
    const frxusd = cardById.get("frxusd-frax");
    const sfrxusd = cardById.get("sfrxusd-frax");

    expect(ybold?.dimensions.decentralization.score).toBe((bold?.dimensions.decentralization.score ?? 0) - 5);
    expect(sbold?.dimensions.decentralization.score).toBe((bold?.dimensions.decentralization.score ?? 0) - 5);
    expect(bold?.rawInputs.oracleRiskTier).toBe("redundant-with-failover");
    expect(bold?.oracleRisk?.branches?.map((branch) => branch.id)).toEqual(["weth", "wsteth", "reth"]);
    expect(ybold?.rawInputs.oracleRiskTier ?? null).toBeNull();
    expect(ybold?.oracleRisk?.inheritedFrom).toMatchObject({ id: "bold-liquity", symbol: "BOLD" });
    expect(sbold?.oracleRisk?.inheritedFrom).toMatchObject({ id: "bold-liquity", symbol: "BOLD" });
    // v8.11: frxUSD starts at 75 after its third-party bridge infra penalty,
    // then the reviewed external-lock/mint bridge route drags it to 68 before
    // MAS 64 applies once: round(68*0.65 + 64*0.35) = 67. Wrappers inherit the
    // parent's pre-MAS score minus haircut, then take their own MAS drag once.
    // sfrxUSD was re-reviewed to its own external-lock-mint tier: its six
    // non-native deployments are FraxZero LayerZero OFTs, so it no longer
    // rides the parent's milder issuer-native-burn-mint grade.
    expect(frxusd?.dimensions.decentralization.score).toBe(67);
    expect(sfrxusd?.dimensions.decentralization.score).toBe(60);
    expect(ybold?.dimensions.decentralization.score).toBeGreaterThan(10);
    expect(sbold?.dimensions.decentralization.score).toBeGreaterThan(10);
    expect(sfrxusd?.dimensions.decentralization.score).toBeGreaterThan(10);
  });

  it("projects reviewed bridge-route risk into report-card raw inputs and display payload", () => {
    const { cards } = buildLiveReportCards({
      pegDataById: new Map(),
      activeDepegPeakBpsById: new Map(),
      dexLiqMap: {},
      redemptionBackstopMap: {},
      bluechipMap: {},
      resolvedBlacklistStatuses: new Map(),
      liveReserveMap: new Map(),
    });

    const usdb = cards.find((card) => card.id === "usdb-blast");
    expect(usdb?.rawInputs.bridgeRouteRiskTier).toBe("external-lock-mint");
    expect(usdb?.rawInputs.bridgeRouteRiskScore).toBe(40);
    expect(usdb?.bridgeRouteRisk).toMatchObject({
      tier: "external-lock-mint",
      score: 40,
      confidence: "verified",
    });
    expect(usdb?.bridgeRouteRisk?.sources?.length).toBeGreaterThan(0);
  });
});
