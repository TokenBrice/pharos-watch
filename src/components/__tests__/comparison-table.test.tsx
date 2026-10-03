import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonTable } from "@/components/comparison-table";
import type { StablecoinData } from "@shared/types";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeUnreportedBluechipRating } from "@shared/test-utils/bluechip.test-support";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";
import { BLUECHIP_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/bluechip-freshness";
import { makeReportCardsV9Card, makeReportCardsV9Pillars } from "@shared/test-utils/report-cards-v9";

afterEach(() => vi.restoreAllMocks());

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
    safetyCard: makeReportCardsV9Card({
      score: 84,
      grade: "A-",
      pillars: makeReportCardsV9Pillars({ backing: 90, exit: 88, control: 42 }),
      evidence: { level: "adequate", freshness: "stale", reasons: [] },
    }),
  } as unknown as ComparisonCoinEntry;
}

const PEG_RATES: Record<string, number> = { USD: 1 };

describe("ComparisonTable", () => {
  it("does not frame unequal directional activity as a universal best value", () => {
    const minting = makeCoin("usdt", "USDT");
    const burning = makeCoin("usdc", "USDC");
    burning.flow = { ...burning.flow!, netFlow24hUsd: -2_000_000, pressureShiftScore: -28 };
    const html = renderToStaticMarkup(
      <ComparisonTable coins={[minting, burning]} pegRates={PEG_RATES} logos={{}} />,
    );
    expect(html).toContain("+$1.00M");
    expect(html).toContain("-$2.00M");
    expect(html).not.toMatch(/\bbest\b/i);
  });

  it("marks missing Bluechip audit data as not reported", () => {
    const coin = makeCoin("usdt", "USDT");
    coin.bluechipRating = makeUnreportedBluechipRating();
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);

    expect(html).toContain("A · audit not reported");
    expect(html).not.toContain("no audit flag");
  });

  it.each([
    { state: "current", age: 0, label: null },
    { state: "retained", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC, label: "retained" },
    { state: "current", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC + 1, label: "stale retained" },
    { state: "retained", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC + 1, label: "stale retained" },
    { state: "unknown", age: null, label: "observation unknown" },
    { state: "current", age: -1, label: "observation unknown" },
  ] as const)("keeps $state age=$age provenance with the external grade", ({ state, age, label }) => {
    const now = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const coin = makeCoin("usdt", "USDT");
    coin.bluechipRating = {
      ...makeUnreportedBluechipRating(),
      lastObservedAt: age == null ? null : now - age,
      observationState: state,
      observationReason: state === "retained" ? "http-500" : null,
    };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    const externalRow = html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*External Bluechip(?:(?!<\/tr>)[\s\S])*<\/tr>/)?.[0];
    expect(externalRow).toBeDefined();
    expect(externalRow).toContain(`A · audit not reported${label ? ` · ${label}` : ""}</td>`);
    expect(externalRow).not.toContain("Not rated");
    if (!label) expect(externalRow).not.toMatch(/retained|observation unknown/);
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

  it.each([
    { label: "unusable price", deviation: null, nav: false, limited: false },
    { label: "NAV token", deviation: null, nav: true, limited: false },
    { label: "below event floor", deviation: 500, nav: false, limited: true },
    { label: "observed near peg", deviation: 2, nav: false, limited: false },
  ])("reports incident absence without a peg verdict for $label", ({ deviation, nav, limited }) => {
    const coin = makeCoin("test", "TST");
    coin.meta = { ...coin.meta, flags: { ...coin.meta.flags, navToken: nav } };
    coin.pegDetails = { ...coin.pegDetails!, currentDeviationBps: deviation, activeDepeg: false, depegEventCoverageLimited: limited };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    const row = html.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Open recorded incident[\s\S]*?<\/tr>/)?.[0];
    expect(row).toContain(">No<");
    expect(row).not.toContain("At peg");
  });

  it.each([true, null])("distinguishes an open incident from missing event coverage (%s)", (active) => {
    const coin = makeCoin("test", "TST");
    coin.pegDetails = active === null ? null : { ...coin.pegDetails!, activeDepeg: active };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    const row = html.match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Open recorded incident[\s\S]*?<\/tr>/)?.[0];
    expect(row).toContain(active === null ? "—" : ">Yes<");
    expect(row).not.toContain(">No<");
  });

  it("keeps missing current supply unavailable instead of $0 or a -100% change", () => {
    const missing = makeCoin("usdt", "USDT");
    missing.data = { ...missing.data, circulating: {}, circulatingPrevWeek: { peggedUSD: 98_000_000_000 } };
    const missingHtml = renderToStaticMarkup(<ComparisonTable coins={[missing]} pegRates={PEG_RATES} logos={{}} />);

    expect(missingHtml).not.toContain("$0.00");
    expect(missingHtml).not.toMatch(/-100\.0+%|-100%/);

    const explicitZero = makeCoin("usdt", "USDT");
    explicitZero.data = { ...explicitZero.data, circulating: { peggedUSD: 0 }, circulatingPrevWeek: { peggedUSD: 98_000_000_000 } };
    const zeroHtml = renderToStaticMarkup(<ComparisonTable coins={[explicitZero]} pegRates={PEG_RATES} logos={{}} />);

    expect(zeroHtml).toContain("$0.00");
    expect(zeroHtml).toMatch(/-100\.0+%|-100%/);
  });
});
