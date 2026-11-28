import { afterAll, describe, expect, it, vi } from "vitest";
import { MORPHO_NET_YIELD_SOURCES } from "../../yield-source-cadence";
import { makeYieldProvenance, makeYieldRanking } from "../../../test-utils/yield-ranking-fixtures";
import { buildSelectorRows, type BuildSelectorRowsArgs } from "../data-adapter";
import { applyInputDrivenExclusions, evaluateExclusions, hasRequiredSignals } from "../exclusions";
import { buildClosestSurvivors } from "../output-helpers";
import { evaluateReferenceAdmission } from "../../reference-admission";
import { asRawDeviationBps } from "../../../types/reference-admission";
import { selectYieldSource } from "../yield-source";
import { makeInput } from "./fixture";
import type * as ClientRegistry from "../../stablecoins/client-registry";

// Non-isolated suites may have loaded the adapter before this registry mock.
vi.hoisted(() => vi.resetModules());

// Do not leak the compact fixture registry or its dependent modules into
// later non-isolated suites, including canonical snapshot census validation.
afterAll(() => {
  vi.doUnmock("../../stablecoins/client-registry");
  vi.resetModules();
});

vi.mock("../../stablecoins/client-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof ClientRegistry>();
  const base = actual.CLIENT_ACTIVE_META_BY_ID.get("usdc-circle")!;
  // A Noble-only deadline alert must stay off every asset-wide selector read.
  const reviewed = { ...base, custodyModel: "cex" as const, alerts: [
    { type: "warning" as const, title: "Noble route closes", kind: "deadline" as const, deadline: "2023-11-20", chains: ["noble"] },
  ] };
  const unreviewed = { ...base, id: "unreviewed", custodyModel: undefined };
  const structural = {
    ...unreviewed,
    id: "structural",
    flags: { ...base.flags, backing: "crypto-backed" as const, governance: "decentralized" as const },
  };
  const halted = { ...reviewed, id: "halted", alerts: [
    { type: "warning" as const, title: "Redemptions paused", kind: "paused" as const },
    { type: "danger" as const, title: "Chain halted" },
  ] };
  const morpho = Object.values(MORPHO_NET_YIELD_SOURCES).map(({ stablecoinId }) => actual.CLIENT_ACTIVE_META_BY_ID.get(stablecoinId)!);
  const coins = [reviewed, unreviewed, structural, halted, actual.CLIENT_ACTIVE_META_BY_ID.get("paxg-paxos")!, ...morpho];
  return {
    ...actual,
    CLIENT_TRACKED_STABLECOINS: coins,
    CLIENT_ACTIVE_META_BY_ID: new Map(coins.map((coin) => [coin.id, coin])),
  };
});
import type {
  DexLiquidityMap,
} from "../../../types/dex-liquidity";
import type {
  PegSummaryResponse,
} from "../../../types/peg";
import type {
  ReportCardsV9CurrentResponse,
} from "../../../types/report-cards-v9-current";
import type {
  StablecoinListResponse,
} from "../../../types/supply";
import type {
  StressSignalsAllResponse,
} from "../../../types/stress";

const EMPTY_ARGS: BuildSelectorRowsArgs = {
  stablecoinsData: null, pegCurrency: null, pegData: null, reportData: null,
  stressData: null, dexData: null, yieldData: null, now: 1_700_000_000_000,
};

function adaptYield(
  ranking: Record<string, unknown> & { id?: string },
  response: Record<string, unknown> = {},
  now = NOW,
  yieldAgeAssessedAt: number | null = NOW,
) {
  const { id = "usdc-circle" } = ranking;
  return buildSelectorRows({
    ...EMPTY_ARGS,
    now,
    yieldAgeAssessedAt,
    yieldData: { rankings: [{ id, yieldType: "lending", yieldSource: "Aave",
      apy30d: 5, pharosYieldScore: 80, ...ranking }], ...response } as unknown as BuildSelectorRowsArgs["yieldData"],
  }).rows.get(id)!;
}

const NOW = 1_700_000_000_000;

describe("buildSelectorRows", () => {
  it("retains structural onchain eligibility without inferring institutional custody", () => {
    const rows = [...buildSelectorRows({ ...EMPTY_ARGS, pegCurrency: "USD" }).rows.values()];
    const eligibleIds = (custodyOk: "any" | "onchain-only" | "regulated-only") => rows
      .filter((row) => applyInputDrivenExclusions(row, makeInput({ custodyOk })) === null)
      .map((row) => row.id);
    const morphoIds = Object.values(MORPHO_NET_YIELD_SOURCES).map(({ stablecoinId }) => stablecoinId);
    expect(eligibleIds("onchain-only")).toEqual(["structural", ...morphoIds]);
    expect(eligibleIds("regulated-only")).toEqual([]);
    expect(eligibleIds("any")).toEqual(["usdc-circle", "unreviewed", "structural", "halted", ...morphoIds]);
  });

  it("maps current V9 report-card fields into selector rows", () => {
    const result = buildSelectorRows({
      stablecoinsData: {
        peggedAssets: [
          {
            id: "usdc-circle",
            circulating: { peggedUSD: 32_000_000_000 },
          },
        ],
      } as unknown as StablecoinListResponse,
      pegCurrency: "USD",
      pegData: {
        coins: [
          {
            id: "usdc-circle",
            pegScore: 96,
            currentDeviationBps: 4,
            activeDepeg: false,
            eventCount: 2,
            lastEventAt: 1_690_000_000,
            trackingSpanDays: 2_000,
            priceObservedAt: NOW / 1000,
            priceUpdatedAt: null,
            priceSyncedAt: null,
          },
        ],
        methodology: { version: "peg-v3" },
      } as PegSummaryResponse,
      reportData: {
        methodology: { version: "v9.1" },
        cards: [
          {
            id: "usdc-circle",
            score: 91,
            grade: "A+",
            pillars: {
              backing: { score: 82 },
              exit: { score: 77 },
              control: { score: 64 },
            },
            evidence: { level: "adequate" },
            weakestPillar: { pillar: "control", score: 64 },
            bindingCap: {
              kind: "reason:evidence-cap",
              limit: 85,
              source: "evidence",
              reason: "Evidence cap fixture.",
              binding: true,
            },
            nrReasons: [],
            accessPosture: { freezeExposure: "direct" },
            dependencies: {
              serial: [{ upstreamAssetId: "upstream", score: 70, blocked: false }],
              basket: [],
              cycleBlocked: false,
              reasonCodes: [],
            },
          },
        ],
      } as unknown as ReportCardsV9CurrentResponse,
      stressData: {
        signals: {
          "usdc-circle": { score: 42, computedAt: NOW / 1000 - 60 },
        },
        updatedAt: NOW / 1000,
        methodology: { version: "dews-v3" },
      } as unknown as StressSignalsAllResponse,
      dexData: {
        "usdc-circle": {
          liquidityScore: 88,
          effectiveTvlUsd: 250_000_000,
          effectiveDepth: { coverage: "partial", amountUsd: 250_000_000, pausedPoolCount: 0, unknownPoolCount: 1 },
          concentrationHhi: 0.2,
          chainTvl: { Ethereum: 250_000_000 },
          updatedAt: NOW / 1000,
          dexDeviationBps: 8,
        },
      } as unknown as DexLiquidityMap,
      yieldData: null,
      now: NOW,
    });

    const row = result.rows.get("usdc-circle");
    expect(row).toBeDefined();
    expect(row).toMatchObject({
      safetyScore: 91,
      safetyProvenance: "safety-score-v9",
      safetyGrade: "A+",
      safetyResilienceScore: 82,
      safetyLiquidityScore: 77,
      safetyDecentralizationScore: 64,
      safetyEvidenceLevel: "adequate",
      safetyWeakestPillar: { pillar: "control", score: 64 },
      safetyBindingCap: expect.objectContaining({ limit: 85, reason: "Evidence cap fixture." }),
      safetyNrReasons: [],
      pegScore: 96,
      dewsScore: 42,
      liquidityScore: 88,
      effectiveTvlUsd: null,
      canBeBlacklisted: true,
      custodyModel: "cex",
      currentDeviationBps: 4,
      supplyUsd: 32_000_000_000,
    });
    expect(result.methodologyVersions).toMatchObject({
      safetyScore: "v9.1",
      pegScoreAndDews: "peg-v3+dews-v3",
    });
    expect(result.datasetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("carries the highest curated holder notice, never a chain-scoped one", () => {
    const stablecoinsData = { peggedAssets: ["usdc-circle", "halted"].map((id) => ({ id, circulating: { peggedUSD: 10_000_000 } })) };
    const rows = buildSelectorRows({ ...EMPTY_ARGS, stablecoinsData: stablecoinsData as unknown as StablecoinListResponse }).rows;
    expect(rows.get("halted")!.holderNotice).toEqual({ kind: "critical", title: "Chain halted" });
    expect(rows.get("usdc-circle")!.holderNotice).toBeNull();
    expect(["usdc-circle", "halted"].map((id) => evaluateExclusions(rows.get(id)!, makeInput())?.reason ?? null))
      .toEqual([null, "critical-notice"]);
  });

  it("keeps an unread supply distinct from an explicit zero", () => {
    const rows = buildSelectorRows({
      ...EMPTY_ARGS,
      stablecoinsData: {
        peggedAssets: [
          { id: "usdc-circle", circulating: { peggedUSD: 0 } },
          { id: "unreviewed", circulating: {} },
        ],
      } as unknown as StablecoinListResponse,
    }).rows;
    expect(rows.get("usdc-circle")!.supplyUsd).toBe(0);
    expect(rows.get("unreviewed")!.supplyUsd).toBeNull();
    expect(buildSelectorRows(EMPTY_ARGS).rows.get("usdc-circle")!.supplyUsd).toBeNull();
  });
});


describe("yield ingestion", () => {
  it("stamps the Morpho quote exclusion policy as selector-v2.16", () => {
    expect(buildSelectorRows(EMPTY_ARGS).methodologyVersions.exclusionFilters).toBe("selector-v2.16");
  });

  it.each(Object.values(MORPHO_NET_YIELD_SOURCES).flatMap(({ stablecoinId, sourceKey, corroboratingPoolId }) => [
    { sourceKey, comparisonKey: corroboratingPoolId },
    { sourceKey, comparisonKey: `linked-variant:${stablecoinId}:${corroboratingPoolId}` },
  ]))("excludes the comparison quote $comparisonKey", ({ sourceKey, comparisonKey }) => {
    const input = makeInput({ profile: "yield", minApy: 3.5 });
    const sourceRisk = { venueProtocol: "morpho-blue", venueChain: "ethereum" };
    const row = adaptYield({ apy30d: 3, provenance: { sourceKey }, sourceRisk, altSources: [
      { sourceKey: comparisonKey, yieldType: "lending-vault", apy30d: 4, sourceRisk },
    ] });
    expect.soft(selectYieldSource(row, input)).toBeNull();
    expect.soft(selectYieldSource(row, { ...input, minApy: 3 })).toMatchObject({ sourceKey });
    const legacy = adaptYield({ apy30d: 4, provenance: { sourceKey: comparisonKey }, sourceRisk });
    expect(selectYieldSource(legacy, input)).toBeNull();
  });

  it.each(Object.values(MORPHO_NET_YIELD_SOURCES))("only recommends $stablecoinId's share-price rates as fallbacks", ({ stablecoinId, sourceKey, vaultAddress }) => {
    const sourceRisk = { venueProtocol: "morpho-blue", venueChain: "ethereum" };
    const input = makeInput({ profile: "yield", minApy: 3.5 });
    for (const prefix of ["", `linked-variant:${stablecoinId}:`]) {
      const id = prefix ? "usdc-circle" : stablecoinId;
      const onchain = { sourceKey: `${prefix}onchain:${stablecoinId}`, yieldType: "lending-vault", apy30d: 5, sourceRisk };
      const supplemental = { ...onchain, sourceKey: `protocol-api:morpho-vault:ethereum:${vaultAddress}`, apy30d: 6 };
      const price = { ...onchain, sourceKey: `${prefix}price-derived`, apy30d: 4 };
      for (const fallbackQuote of [onchain, price]) {
        const net = adaptYield({ id, provenance: { sourceKey: prefix + sourceKey }, apy30d: 3, sourceRisk, altSources: [fallbackQuote, supplemental] });
        expect.soft(selectYieldSource(net, input)).toBeNull();
        expect.soft(selectYieldSource(net, { ...input, minApy: 3 })).toMatchObject({ sourceKey: prefix + sourceKey });
        const fallback = adaptYield({ id, provenance: { sourceKey: fallbackQuote.sourceKey }, sourceRisk, altSources: [supplemental] });
        expect.soft(fallback.yieldSources?.map((quote) => quote.sourceKey)).toEqual([fallbackQuote.sourceKey]);
      }
    }
  });

  it("marks structured-tranche model substitution ineligible for V9 coverage", () => {
    const row = adaptYield({ yieldType: "structured-tranche", safetyScore: 99, safetyGrade: "A+" });
    expect(row).toMatchObject({ safetyScore: 99, safetyGrade: "A+", safetyProvenance: "yield-opportunity" });
    expect(hasRequiredSignals(row, "yield").missing).toContain("safety-score-v9");
    expect(adaptYield({ yieldType: "structured-tranche", safetyScore: 99 }).safetyScore).toBeNull();
  });

  it("names the trailing-window count as distinct 30d observation days", () => {
    const row = adaptYield({ sourceRisk: { observationCount30d: 30 } });
    expect(row.yieldObservationDays30d).toBe(30);
    expect(row).not.toHaveProperty("yieldHistoryDays");
  });

  it("honors benchmark precedence and explicit false source-switch evidence", () => {
    const response = { provenance: { benchmark: { rate: 3 } }, riskFreeRate: 4 };
    const cases = [
      { ranking: { benchmarkRate: 1, provenance: { benchmarkRate: 2, sourceSwitch: false },
        decisionLedger: { sourceSwitch: true }, sourceRisk: { sourceSwitchCount30d: 2 } }, rate: 1, switched: false },
      { ranking: { provenance: { benchmarkRate: 2 }, decisionLedger: { sourceSwitch: false },
        sourceRisk: { sourceSwitchCount30d: 2 } }, rate: 2, switched: false },
      { ranking: { sourceRisk: { sourceSwitchCount30d: 2 } }, rate: 3, switched: true },
    ];
    for (const { ranking, rate, switched } of cases) {
      expect(adaptYield(ranking, response)).toMatchObject({ benchmarkRate: rate, sourceSwitch: switched });
    }
    expect(adaptYield({}, { riskFreeRate: 4 }).benchmarkRate).toBe(4);
  });

  it("normalizes primary and alternate venues before preference-based source selection", () => {
    const row = adaptYield({
      sourceRisk: { venueProtocol: "Aave", venueChain: "ethereum", venueRiskTier: "medium",
        deploymentPlace: "lending-market", sourceAgeSeconds: 60 },
      altSources: [{ sourceKey: "curve-lp", yieldSource: "Curve", yieldType: "lp-receipt", apy30d: 4,
        sourceRisk: { venueProtocol: "Curve", venueChain: "ethereum", venueRiskTier: "low",
          deploymentPlace: "lp-or-dex", sourceAgeSeconds: 120 } }],
    });
    expect(row.yieldSources).toMatchObject([
      { sourceKey: "Aave:ethereum:lending", venueRiskTier: "mid", deploymentPlace: "lending", isPrimary: true },
      { sourceKey: "curve-lp", venueRiskTier: "low", deploymentPlace: "lp", isPrimary: false, pharosYieldScore: null },
    ]);
    expect(selectYieldSource(row, makeInput({ profile: "yield", venuePreferences: ["dex"] })))
      .toMatchObject({ sourceKey: "curve-lp", selectionReason: "venue-preference" });
    expect(selectYieldSource(row, makeInput({ profile: "yield", venuePreferences: ["lend"] })))
      .toMatchObject({ sourceKey: "Aave:ethereum:lending" });
  });

  it("ages explicit observations at the dataset clock even when the published age is absent or frozen", () => {
    for (const sourceAgeSeconds of [7, null]) {
      for (const now of [NOW, NOW / 1000]) {
        expect(adaptYield({ provenance: { sourceObservedAt: NOW / 1000 - 60, sourceAgeSeconds } }, {}, now)
          .yieldFreshness).toEqual({ capturedAt: 1_699_999_940, ageSeconds: 60 });
      }
    }
  });

  it.each([NOW / 1000 + 60, NOW / 1000 + 0.1, Number.NaN, Number.POSITIVE_INFINITY])("keeps invalid/future provenance %s freshness unknown", sourceObservedAt => {
    const row = adaptYield({ provenance: { sourceObservedAt }, sourceRisk: { sourceAgeSeconds: 0 } });
    expect(row.yieldFreshness).toBeNull();
    expect(row.yieldSources![0].freshness).toBeNull();
  });

  it("keeps future age-only primary and alternate source instants unknown", () => {
    const row = adaptYield({
      sourceRisk: { sourceAgeSeconds: 0 },
      altSources: [{ sourceKey: "alt", sourceRisk: { sourceAgeSeconds: 0 } }],
    }, {}, NOW, NOW + 60_000);
    expect(row.yieldFreshness).toBeNull();
    expect(row.yieldSources!.map(source => source.freshness)).toEqual([null, null]);
    expect(adaptYield({ provenance: { sourceObservedAt: NOW / 1000 } }).yieldFreshness)
      .toEqual({ capturedAt: NOW / 1000, ageSeconds: 0 });
  });

  it.each([false, true])("retains primary and alternate source instants across unrelated refreshes (legacy=%s)", (legacy) => {
    const ranking = {
      ...(legacy ? {} : { provenance: { sourceObservedAt: NOW / 1000 - 60, sourceAgeSeconds: 60 } }),
      sourceRisk: { sourceAgeSeconds: 60 },
      altSources: [{ sourceKey: "alt", sourceRisk: { sourceAgeSeconds: 120 } }],
    };
    const first = adaptYield(ranking);
    for (const now of [NOW + 3_600_000, NOW / 1000 + 3_600]) {
      const later = adaptYield(ranking, {}, now);
      expect(first.yieldFreshness).toEqual({ capturedAt: 1_699_999_940, ageSeconds: 60 });
      expect(later.yieldFreshness).toEqual({ capturedAt: 1_699_999_940, ageSeconds: 3_660 });
      expect(later.yieldSources![0]!.freshness).toEqual(later.yieldFreshness);
      expect(first.yieldSources![1]!.freshness).toEqual({ capturedAt: 1_699_999_880, ageSeconds: 120 });
      expect(later.yieldSources![1]!.freshness).toEqual({ capturedAt: 1_699_999_880, ageSeconds: 3_720 });
    }
  });

  it("leaves age-only evidence unavailable without a yield assessment clock, regardless of publication time", () => {
    const row = adaptYield({
      sourceRisk: { sourceAgeSeconds: 60 },
      altSources: [{ sourceKey: "alt", sourceRisk: { sourceAgeSeconds: 120 } }],
    }, { updatedAt: NOW / 1000 }, NOW, null);
    expect(row.yieldFreshness).toBeNull();
    expect(row.yieldSources!.map((source) => source.freshness)).toEqual([null, null]);
    expect(adaptYield({
      provenance: { sourceObservedAt: null, sourceAgeSeconds: 60 },
      sourceRisk: { sourceAgeSeconds: 0 },
    }).yieldFreshness).toBeNull();
  });

  it("keeps dataset identity stable when only the observation age advances", () => {
    const yieldData = {
      rankings: [makeYieldRanking({ provenance: makeYieldProvenance({ sourceObservedAt: NOW / 1000 - 60 }) })],
    } as unknown as BuildSelectorRowsArgs["yieldData"];
    const buildAt = (now: number) => buildSelectorRows({
      ...EMPTY_ARGS, now, yieldData,
    });
    const first = buildAt(NOW);
    const later = buildAt(NOW + 60_000);
    expect(first.rows.get("usdc-circle")?.yieldFreshness).toEqual({ capturedAt: NOW / 1000 - 60, ageSeconds: 60 });
    expect(later.rows.get("usdc-circle")?.yieldFreshness).toEqual({ capturedAt: NOW / 1000 - 60, ageSeconds: 120 });
    // Content-addressed identity must not move with the evaluation clock: the
    // dataset hash keys the snapshot KV entry and the frozen-vs-live comparison.
    expect(later.datasetHash).toBe(first.datasetHash);
  });

  it("leaves producer clocks ahead of the assessment clock unavailable instead of clamping to zero", () => {
    const nowSec = NOW / 1000;
    const args: BuildSelectorRowsArgs = {
      ...EMPTY_ARGS,
      stablecoinsData: {
        peggedAssets: [{ id: "usdc-circle", circulating: { peggedUSD: 32_000_000_000 } }],
      } as unknown as StablecoinListResponse,
      pegCurrency: "USD",
      pegData: {
        coins: [{
          id: "usdc-circle", priceSource: "coingecko", priceObservedAtMode: "upstream",
          priceObservedAt: nowSec + 3_600, priceUpdatedAt: null, priceSyncedAt: null,
        }],
        methodology: { version: "peg-v3" },
      } as unknown as PegSummaryResponse,
      stressData: {
        signals: { "usdc-circle": { score: 20, computedAt: nowSec + 3_600 } },
        updatedAt: nowSec + 3_600,
        methodology: { version: "dews-v3" },
      } as unknown as StressSignalsAllResponse,
      dexData: {
        "usdc-circle": { liquidityScore: 80, effectiveTvlUsd: 250_000_000, updatedAt: nowSec + 3_600 },
      } as unknown as DexLiquidityMap,
      now: NOW,
    };
    const row = buildSelectorRows(args).rows.get("usdc-circle")!;
    expect(row.pegSummaryAgeSec).toBeNull();
    expect(row.dexTvlAgeSec).toBeNull();
    expect(row.dewsAgeSec).toBeNull();
  });

  it.each([
    { label: "missing legacy reading", raw: null, admitted: undefined, expected: null },
    { label: "observed legacy reading", raw: 4, admitted: undefined, expected: 4 },
    { label: "explicitly unavailable projection", raw: 4, admitted: null, expected: null },
    { label: "observed zero projection", raw: 4, admitted: 0, expected: 0 },
  ])("uses fixed USD without falling back to DEX or overriding the projection: $label", ({ raw, admitted, expected }) => {
    const row = buildSelectorRows({
      ...EMPTY_ARGS,
      pegCurrency: "USD",
      pegData: {
        coins: [{ id: "usdc-circle", currentDeviationBps: raw, admittedDeviationBps: admitted }],
        methodology: { version: "peg-v3" },
      } as unknown as BuildSelectorRowsArgs["pegData"],
      dexData: {
        "usdc-circle": { liquidityScore: 80, dexDeviationBps: 8 },
      } as unknown as DexLiquidityMap,
      now: NOW,
    }).rows.get("usdc-circle")!;
    expect(row.currentDeviationBps).toBe(expected);
  });

  it.each([
    { label: "legacy reading", at: null, before: 2_000, deviation: undefined, expected: -40 },
    { label: "closed", at: "2026-11-21T12:00:00Z", before: 2_000, deviation: -40, expected: null, notice: "Reference market closed" },
    { label: "stale", at: "2026-11-23T12:00:00Z", before: 2_100, deviation: -40, expected: null, notice: "Reference not yet updated" },
    { label: "admitted without a value", at: "2026-11-23T12:00:00Z", before: 2_000, deviation: null, expected: null },
    { label: "admitted zero", at: "2026-11-23T12:00:00Z", before: 2_000, deviation: 0, expected: 0 },
    { label: "quote predates admission", quoteOffset: -1, at: "2026-11-23T12:00:00Z", before: 2_000, deviation: -40, expected: null },
    { label: "quote postdates admission", quoteOffset: 1, at: "2026-11-23T12:00:00Z", before: 2_000, deviation: -40, expected: null },
    { label: "admitted fractional", at: "2026-11-23T12:00:00Z", before: 2_000, deviation: -40.25, expected: -40.25 },
  ])("uses legacy or admitted gold deviations for the active-depeg gate: $label", ({ at, before, deviation, expected, notice, quoteOffset = 0 }) => {
    const id = "paxg-paxos";
    const observedAtSec = at == null ? null : Date.parse(at) / 1000;
    const referenceAdmission = observedAtSec == null ? undefined : evaluateReferenceAdmission({
      kind: "fallback", decisionAtSec: observedAtSec, quoteObservedAtSec: observedAtSec,
      rawDeviationBps: asRawDeviationBps(-40), preCloseUsdPerUnit: before,
      observation: { pegKey: "peggedGOLD", usdPerUnit: 2_100, source: "gold-api.com", cadence: "intraday", observedAtSec },
    });
    const row = buildSelectorRows({
      ...EMPTY_ARGS, pegCurrency: "GOLD", now: (observedAtSec ?? NOW / 1000) + 30,
      stablecoinsData: {
        peggedAssets: [{ id, circulating: { peggedGOLD: 10_000_000 } }],
      } as unknown as StablecoinListResponse,
      pegData: { coins: [{ id, activeDepeg: true, pegScore: 95, currentDeviationBps: -40,
        priceObservedAt: observedAtSec == null ? null : observedAtSec + quoteOffset,
        referenceAdmission, admittedDeviationBps: deviation }] } as unknown as BuildSelectorRowsArgs["pegData"],
    }).rows.get(id)!;
    expect(row.currentDeviationBps).toBe(expected);
    const input = makeInput({ pegCurrency: "GOLD", depegTolerance: "tight" });
    const exclusion = evaluateExclusions(row, input);
    if (expected != null) {
      expect(exclusion).toBeNull();
    } else {
      expect(exclusion).toMatchObject({ reason: "active-depeg", severity: "hard" });
      if (notice) {
        expect(exclusion?.detail).toBe(notice);
        expect(buildClosestSurvivors([exclusion!], [row], input, () => null)[0]?.liveReading).toBe(notice);
      }
    }
  });
});
