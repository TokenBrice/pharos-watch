import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonTable } from "@/components/comparison-table";
import type { StablecoinData } from "@shared/types";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";

vi.mock("next/link", async () => {
  const { createNextLinkMock } = await import("@/test-utils/frontend");
  return createNextLinkMock();
});

function makeData(circulating: number): StablecoinData {
  return makeStablecoin({
    id: "test",
    name: "Test",
    symbol: "TST",
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1,
    circulating: { peggedUSD: circulating },
    circulatingPrevWeek: { peggedUSD: circulating * 0.98 },
  });
}

function makeCoin(id: string, symbol: string): ComparisonCoinEntry {
  return {
    id,
    symbol,
    name: symbol,
    data: makeData(100_000_000_000),
    meta: {
      id,
      name: symbol,
      symbol,
      flags: {
        backing: "rwa-backed",
        pegCurrency: "USD",
        governance: "centralized",
        yieldBearing: false,
        rwa: true,
        navToken: false,
      },
      blacklistStatus: true,
      launchDate: "2018-01-01",
      reserves: [{ name: "Treasury bills", pct: 80, risk: "very-low" }],
    },
    pegDetails: {
      pegScore: 95,
      currentDeviationBps: 2,
      activeDepeg: false,
      recent90d: { pegPct: 99.8, incidentCount: 1 },
      eventCount: 3,
      trackingSpanDays: 900,
      worstDeviationBps: 42,
      priceConfidence: "high",
      consensusSources: ["source-a", "source-b"],
    },
    liquidity: {
      liquidityScore: 80,
      effectiveTvlUsd: 1_000_000_000,
      totalVolume24hUsd: 250_000_000,
      poolCount: 12,
      chainCount: 4,
      liquidityEvidenceClass: "measured",
      concentrationHhi: 0.4,
    },
    redemption: {
      score: 88,
      routeFamily: "offchain-issuer",
      routeStatus: "operational",
      holderEligibility: "verified-customer",
      settlementModel: "same-day",
      immediateCapacityUsd: 500_000_000,
      feeBps: 10,
    },
    flow: {
      netFlow24hUsd: 1_000_000,
      netFlow7dUsd: 20_000_000,
      netFlow30dUsd: 1_240_000_000,
      netFlow90dUsd: 2_000_000_000,
      pressureShiftState: "stable",
      pressureShiftScore: 8,
    },
    yield: {
      apy30d: 4.5,
      excessYield: 0.8,
      pharosYieldScore: 72,
      yieldStability: 0.9,
      yieldSource: "Issuer yield",
      sourceTvlUsd: 900_000_000,
    },
    stress: { band: "LOW", score: 12 },
    safetyCard: {
      score: 84,
      grade: "A-",
      pillars: {
        backing: { score: 90 },
        exit: { score: 88 },
        control: { score: 42 },
      },
      weakestPillar: { pillar: "control", score: 42 },
      bindingCap: null,
      evidence: { level: "adequate", freshness: "stale" },
      accessPosture: { primaryExit: "permissionless", freezeExposure: "none-known" },
      dependencies: { serial: [], basket: [] },
    },
  } as unknown as ComparisonCoinEntry;
}

const PEG_RATES: Record<string, number> = { USD: 1 };

describe("ComparisonTable", () => {
  it("renders the complete grouped comparison matrix", () => {
    const html = renderToStaticMarkup(
      <ComparisonTable coins={[makeCoin("usdt", "USDT")]} pegRates={PEG_RATES} logos={{}} />,
    );

    for (const section of [
      "Overview",
      "Peg Track Record",
      "Safety Construction",
      "Exit &amp; Liquidity",
      "Activity &amp; Yield",
      "Structure &amp; Controls",
    ]) {
      expect(html).toContain(section);
    }
    expect(html).toContain("+$1.24B");
    expect(html).toContain("Issuer yield");
    expect(html).toContain("Treasury bills 80%");
    expect(html).toContain("Direct freeze power");
    expect(html).toContain("Open Safety Score waterfall for USDT");
    expect(html).toContain("Evidence age stale");
  });

  it("uses the shared horizontally scrollable table foundation", () => {
    const html = renderToStaticMarkup(
      <ComparisonTable coins={[makeCoin("usdt", "USDT")]} pegRates={PEG_RATES} logos={{}} />,
    );

    expect(html).toContain('data-table-id="live-comparison-matrix"');
    expect(html).toContain('data-testid="live-comparison-matrix-table"');
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Stablecoin comparison matrix"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('data-slot="table-viewport"');
    expect(html).toContain('data-slot="table"');
  });

  it("does not frame directional activity as a universal best value", () => {
    const html = renderToStaticMarkup(
      <ComparisonTable coins={[makeCoin("usdt", "USDT"), makeCoin("usdc", "USDC")]} pegRates={PEG_RATES} logos={{}} />,
    );

    expect(html).not.toContain("text-green-600");
    expect(html).not.toContain("BEST_CLASS");
  });

  it("keeps basis-point values rounded to whole numbers", () => {
    const base = makeCoin("usdt", "USDT");
    const coin = {
      ...base,
      pegDetails: {
        ...base.pegDetails!,
        currentDeviationBps: 2.4,
        worstDeviationBps: -42.6,
      },
    };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);

    expect(html).toContain("+2 bps");
    expect(html).toContain("-43 bps");
    expect(html).not.toContain("+2.4 bps");
    expect(html).not.toContain("-42.6 bps");
  });
});
