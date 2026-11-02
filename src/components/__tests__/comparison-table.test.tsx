import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonTable } from "@/components/comparison-table";
import type { StablecoinData } from "@shared/types";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import { makeUnreportedBluechipRating } from "@shared/test-utils/bluechip.test-support";
import type { ComparisonCoinEntry } from "@/lib/compare-derive";
import { BLUECHIP_OBSERVATION_MAX_AGE_SEC } from "@shared/lib/bluechip-freshness";
import { computeRecentPegStats } from "@shared/lib/peg-score";
import { makeReportCardsV9Card, makeReportCardsV9Pillars, makeReportCardsV9PipelineGapCard } from "@shared/test-utils/report-cards-v9";

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
    bluechipPublicationAvailable: false,
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
      recent90d: {
        windowDays: 90, observedDays: 90, coverageLimited: false, pegPct: 99.8,
        incidentCount: 1, thresholdCrossingCount: 1, worstDeviationBps: 42,
      },
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

function metricRow(html: string, label: string): string | undefined {
  const row = html.split("</tr>").find((chunk) => chunk.includes(label));
  return row ? `${row}</tr>` : undefined;
}

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

  it("keeps a pipeline-gap card out of the withheld top-driver chip", () => {
    const coin = makeCoin("xmd", "XMD");
    coin.safetyCard = makeReportCardsV9PipelineGapCard();
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    expect(html).toContain("Pipeline gap — no Safety Score published");
    expect(html).not.toContain("Score withheld");
    const driverRow = html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*Top driver(?:(?!<\/tr>)[\s\S])*<\/tr>/)?.[0];
    expect(driverRow).toContain("No comparable data available");
    expect(driverRow).not.toContain("Required evidence is withheld");
  });

  it("labels unwired evidence freshness honestly in both evidence and driver rows", () => {
    const coin = makeCoin("test", "TST");
    coin.safetyCard = {
      ...coin.safetyCard!,
      evidence: { level: "limited", freshness: "unknown", reasons: [] },
    };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    expect(html).toContain("Limited · Freshness not assessed");
    expect(html).toContain("Evidence age not assessed");
    expect(html).not.toContain("Evidence age unknown");
  });

  it.each([false, true])("distinguishes whole-feed availability (%s) from an unrated coin", (available) => {
    const coin = makeCoin("usdt", "USDT");
    coin.bluechipPublicationAvailable = available;
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    const row = html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*External Bluechip(?:(?!<\/tr>)[\s\S])*<\/tr>/)?.[0];
    expect(row).toContain(available ? "Not rated" : "No comparable data available");
    if (!available) {
      expect(row).toContain("—");
      expect(row).not.toContain("Not rated");
    }
  });

  it("marks missing Bluechip audit data as not reported", () => {
    const coin = makeCoin("usdt", "USDT");
    coin.bluechipPublicationAvailable = true;
    coin.bluechipRating = makeUnreportedBluechipRating();
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);

    expect(html).toContain("A · audit not reported");
    expect(html).not.toContain("no audit flag");
  });

  it.each([
    { state: "current", age: 0, text: "Observed 2026-09-21" },
    { state: "retained", age: BLUECHIP_OBSERVATION_MAX_AGE_SEC, text: "Observed 2026-09-19" },
    { state: "stale", age: 3 * 86_400, text: "Observed 2026-09-18" },
    { state: "retained", age: 12 * 86_400 + 1, text: "Observed 2026-09-09" },
    { state: "unknown", age: null, text: "Observation date unavailable" },
    { state: "current", age: -1, text: "Observation date unavailable" },
  ] as const)("keeps $state age=$age neutral provenance with the external grade", ({ state, age, text }) => {
    const now = 1_790_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const coin = makeCoin("usdt", "USDT");
    coin.bluechipPublicationAvailable = true;
    coin.bluechipRating = {
      ...makeUnreportedBluechipRating(),
      lastObservedAt: age == null ? null : now - age,
      observationState: state,
      observationReason: state === "retained" ? "http-500" : null,
    };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    const externalRow = html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*External Bluechip(?:(?!<\/tr>)[\s\S])*<\/tr>/)?.[0];
    expect(externalRow).toBeDefined();
    expect(externalRow).toContain(`<span title="${text}">A · audit not reported<span class="sr-only"> · ${text}</span></span></td>`);
    expect(externalRow).not.toContain("Not rated");
    expect(externalRow).not.toMatch(/retained|stale|observation unknown/);
  });

  function occupancyRow(html: string): string | undefined {
    return html.match(/<tr\b[^>]*>(?:(?!<\/tr>)[\s\S])*Time at peg · up to 90d(?:(?!<\/tr>)[\s\S])*<\/tr>/)?.[0];
  }

  it("qualifies a two-day 100% occupancy with its basis, partial coverage and caveat", () => {
    const nowSec = 1_800_000_000;
    const recent = computeRecentPegStats([], nowSec - 2 * 86_400, nowSec)!;
    expect(recent).toMatchObject({ pegPct: 100, observedDays: 2, coverageLimited: true });
    const coin = makeCoin("usdt", "USDT");
    coin.pegDetails = { ...coin.pegDetails!, recent90d: recent };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);
    const row = occupancyRow(html);
    expect(row).toContain("100.00%");
    expect(row).toContain('100.00%<span class="text-muted-foreground" title="Based on 2d · Partial 90-day coverage"> · 2d<span class="sr-only"> of partial 90-day coverage</span></span>');
    expect(row).not.toContain("block text-muted-foreground");
    expect(html).not.toContain("At peg · 90d");
    const describedBy = row?.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}" class="mt-0.5 block text-xs font-normal text-muted-foreground">Time at peg is a record-derived estimate, not proof of recovery or continuous observation. Tracking closure can leave unobserved time.</span>`);
  });

  it.each([
    { label: "full window", recent: { observedDays: 90, coverageLimited: false, pegPct: 99.8 }, value: "99.80%", basis: null },
    { label: "fractional positive basis", recent: { observedDays: 0.4, coverageLimited: true, pegPct: 100 }, value: "100.00%", basis: 'title="Based on &lt;1d · Partial 90-day coverage"> · &lt;1d' },
    { label: "blind window", recent: { observedDays: 0, coverageLimited: true, pegPct: null }, value: "—", basis: 'title="Based on 0d · Partial 90-day coverage"> · 0d' },
    { label: "measured zero occupancy", recent: { observedDays: 30, coverageLimited: true, pegPct: 0 }, value: "0.00%", basis: 'title="Based on 30d · Partial 90-day coverage"> · 30d' },
  ])("renders $label occupancy with a basis marker only for limited coverage", ({ recent, value, basis }) => {
    const coin = makeCoin("usdt", "USDT");
    coin.pegDetails = { ...coin.pegDetails!, recent90d: { ...coin.pegDetails!.recent90d!, ...recent } };
    const row = occupancyRow(renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />));
    expect(row).toContain(value);
    if (basis) expect(row).toContain(basis);
    else expect(row).not.toMatch(/Based on|Partial 90-day coverage/);
    if (recent.pegPct == null) expect(row).not.toMatch(/100\.00%|>0\.00%/);
    if (!recent.coverageLimited) expect(row).not.toContain("Partial 90-day coverage");
  });

  it("keeps missing recent stats a dash without a basis", () => {
    const coin = makeCoin("usdt", "USDT");
    coin.pegDetails = { ...coin.pegDetails!, recent90d: null };
    const row = occupancyRow(renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />));
    expect(row).toContain("—");
    expect(row).not.toContain("Based on");
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

  it.each([
    { currency: "EUR", pegType: "peggedEUR", price: 1.1 },
    { currency: "GOLD", pegType: "peggedGOLD", price: 3300 },
  ] as const)("names valuation-only $currency movement as USD market-cap change", ({ currency, pegType, price }) => {
    const coin = makeCoin("test", "TST");
    coin.meta.flags.pegCurrency = currency;
    // A fixed native balance revalues by 10% in USD; no token issuance.
    coin.data = { ...coin.data, pegType, price, circulating: { [pegType]: 1100 },
      circulatingPrevDay: { [pegType]: 1000 }, circulatingPrevWeek: { [pegType]: 1000 },
      circulatingPrevMonth: { [pegType]: 1000 } };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={{ [currency]: price }} />);
    for (const window of ["24h", "7d", "30d"]) {
      const row = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)?.find((row) => row.includes(`Market-cap change · ${window}`));
      expect(row).toContain("+10.00%");
    }
    expect(html).toContain("USD-valued circulation, not token counts or price returns");
    expect(html).not.toContain("Supply change ·");
  });

  it("withholds market-cap deltas when current supply is a partial-coverage remainder", () => {
    const coin = makeCoin("test", "TST");
    coin.data = { ...coin.data, supplyChainGuard: {
      reason: "supply-chain-dropout", status: "chains-unavailable", partialCoverage: true,
      chains: [{ chainLabel: "HyperEVM", listCurrentUsd: null, baselineUsd: 10, baselineObservedAt: 1, baselineSource: "state", resolution: "unavailable" }],
    } };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} />);
    const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)?.filter((row) => row.includes("Market-cap change ·"));
    expect(rows).toHaveLength(3);
    for (const row of rows ?? []) {
      expect(row).toContain("No comparable data available");
      expect(row).not.toContain("%");
    }
  });

  it("withholds market-cap deltas when historical buckets are missing", () => {
    const coin = makeCoin("test", "TST");
    coin.data = { ...coin.data, circulatingPrevDay: {}, circulatingPrevWeek: {}, circulatingPrevMonth: {} };
    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} />);
    const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)?.filter((row) => row.includes("Market-cap change ·"));
    expect(rows).toHaveLength(3);
    for (const row of rows ?? []) {
      expect(row).toContain("No comparable data available");
      expect(row).not.toContain("%");
    }
  });

  it("does not report an unassessed binding cap as 'None' for non-rated cards", () => {
    const notRated = makeCoin("usdt", "USDT");
    notRated.safetyCard = makeReportCardsV9Card({ score: null });
    const pipelineGap = makeCoin("usdc", "USDC");
    pipelineGap.safetyCard = makeReportCardsV9PipelineGapCard("control", "A", { id: "usdc" });

    const html = renderToStaticMarkup(
      <ComparisonTable coins={[notRated, pipelineGap]} pegRates={PEG_RATES} logos={{}} />,
    );

    const row = metricRow(html, "Binding cap");
    expect(row).not.toContain(">None<");
    expect(row?.match(/No comparable data available/g)).toHaveLength(2);
    expect(html).toContain("Pipeline gap — no Safety Score published");
  });

  it("keeps 'None' for a rated card without a binding cap", () => {
    const coin = makeCoin("usdt", "USDT");
    const row = metricRow(renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} />), "Binding cap");
    expect(row).toContain(">None<");
  });

  it("resolves variant parents and scored dependencies to reader-facing labels", () => {
    const coin = makeCoin("savings-usdt", "SUSDT");
    coin.meta = { ...coin.meta, variantOf: "usdt-tether", variantKind: "savings-passthrough" };
    coin.safetyCard = {
      ...coin.safetyCard!,
      dependencies: {
        ...coin.safetyCard!.dependencies,
        serial: [{
          upstreamAssetId: "usdc-circle", score: 84, ratingStatus: "rated",
          partialEvidence: null, causeGapRefs: [], limitedEvidenceCauses: [], blocked: false,
        }],
        basket: [],
      },
    };

    const html = renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />);

    const variantRow = metricRow(html, "Variant relationship");
    expect(variantRow).toContain("Savings variant of Tether (USDT)");
    expect(variantRow).not.toContain("usdt-tether");
    const dependencyRow = metricRow(html, "Scored dependencies");
    expect(dependencyRow).toContain("USDC");
    expect(dependencyRow).not.toContain("usdc-circle");
  });

  it("names an untracked variant parent without exposing its id", () => {
    const coin = makeCoin("savings-unknown", "SUNK");
    coin.meta = { ...coin.meta, variantOf: "unknown-parent", variantKind: "savings-passthrough" };
    const row = metricRow(
      renderToStaticMarkup(<ComparisonTable coins={[coin]} pegRates={PEG_RATES} logos={{}} />),
      "Variant relationship",
    );
    expect(row).toContain("Savings variant of an untracked asset");
    expect(row).not.toContain("unknown-parent");
  });
});
