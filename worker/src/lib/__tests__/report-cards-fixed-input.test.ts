import { describe, expect, it } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type { DexLiquidityData, ExitRouteObservation } from "@shared/types/market";
import {
  buildReportCardsSnapshotFromFixedInput,
  buildReportCardsFixedInputCacheEntry,
  createReportCardsFixedInput,
  normalizeFixedInput,
  parseReportCardsFixedInputCacheValue,
  serializeNormalizedReportCardsReplay,
} from "../report-cards-fixed-input";

function fixedInput(dexLiqMap: Record<string, DexLiquidityData> = {}) {
  const dexUpdatedAt = Object.values(dexLiqMap)[0]?.updatedAt ?? 1_783_891_100;
  return createReportCardsFixedInput({
    captureKind: "public-reconstruction",
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: "fixture-generation",
    dexGenerationId: `dex-liquidity-${dexUpdatedAt}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: 1_783_891_200,
    updatedAt: 1_783_891_200,
    liquidityStale: false,
    redemptionStale: false,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAt, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap,
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: {
      "usdt-tether": true,
      "usdc-circle": true,
    },
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

function route(routeId: string, commonModeKeys: string[], assetKeys: string[]): ExitRouteObservation {
  return {
    routeId,
    routeFamily: "dex-amm",
    scope: { kind: "chain-contract", chain: "solana", contractOrPoolId: routeId, protocol: "test" },
    requestedNotionalUsd: 100_000,
    settlementHorizonSec: 300,
    maxCostBps: 200,
    executableUsd: 50_000,
    completionRatio: 0.5,
    output: { kind: "collateral", assetKeys },
    evidenceKind: "reserve-based-amm-simulation",
    confidence: "high",
    scoreEligible: true,
    observedAt: 1_783_891_100,
    freshnessSeconds: 100,
    commonModeKeys,
    capacityCurve: [
      { requestedNotionalUsd: 1_000_000, maxCostBps: 200, executableUsd: 50_000, completionRatio: 0.05 },
      { requestedNotionalUsd: 100_000, maxCostBps: 200, executableUsd: 50_000, completionRatio: 0.5 },
    ],
  };
}

function dexRow(exitRouteObservations: ExitRouteObservation[]): DexLiquidityData {
  return {
    totalTvlUsd: 1,
    totalVolume24hUsd: 1,
    totalVolume7dUsd: 1,
    poolCount: 1,
    pairCount: 1,
    chainCount: 1,
    protocolTvl: {},
    chainTvl: {},
    topPools: [],
    liquidityScore: 50,
    concentrationHhi: null,
    depthStability: null,
    tvlChange24h: null,
    tvlChange7d: null,
    updatedAt: 1_783_891_100,
    dexPriceUsd: null,
    dexDeviationBps: null,
    priceSourceCount: null,
    priceSourceTvl: null,
    priceSources: null,
    effectiveTvlUsd: 1,
    avgPoolStress: null,
    weightedBalanceRatio: null,
    organicFraction: null,
    durabilityScore: null,
    coverageClass: "primary",
    coverageConfidence: 1,
    liquidityEvidenceClass: "measured",
    hasMeasuredLiquidityEvidence: true,
    trendworthy: true,
    sourceMix: {},
    balanceMeasuredTvlUsd: 1,
    organicMeasuredTvlUsd: 1,
    scoreComponents: null,
    lockedLiquidityPct: null,
    methodologyVersion: "fixture",
    exitRouteObservations,
  };
}

function exactFixedInput() {
  const dexUpdatedAt = 1_783_891_100;
  return createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    capturedAt: "2026-07-12T22:00:00.000Z",
    sourceGeneration: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1783891200`,
    dexGenerationId: `dex-liquidity-${dexUpdatedAt}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "fixture-revision",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    clockSec: 1_783_891_200,
    updatedAt: 1_783_891_200,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAt, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      ACTIVE_STABLECOINS.map((coin) => [
        coin.id,
        {
          liquidityScore: null,
          concentrationHhi: null,
          poolCount: 0,
          chainCount: 0,
          methodologyVersion: "fixture",
          updatedAt: dexUpdatedAt,
        },
      ]),
    ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(ACTIVE_STABLECOINS.map((coin) => [coin.id, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
}

describe("fixed report-card input replay", () => {
  it("replays byte-stably without network, D1, or wall-clock reads", () => {
    const input = fixedInput();
    const first = serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input));
    const second = serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input));
    expect(first).toBe(second);
    expect(JSON.parse(first).cards.length).toBeGreaterThan(300);
  });

  it("normalizes equivalent record insertion orders", () => {
    const input = fixedInput();
    const permuted = {
      ...input,
      resolvedBlacklistStatuses: Object.fromEntries(Object.entries(input.resolvedBlacklistStatuses).reverse()),
    };
    expect(JSON.stringify(normalizeFixedInput(permuted))).toBe(JSON.stringify(normalizeFixedInput(input)));
    expect(serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(permuted))).toBe(
      serializeNormalizedReportCardsReplay(buildReportCardsSnapshotFromFixedInput(input)),
    );
  });

  it("rejects malformed inputs and unapproved methodology mismatches", () => {
    expect(() => buildReportCardsSnapshotFromFixedInput({ ...fixedInput(), clockSec: Number.NaN })).toThrow(
      "Malformed fixed report-card input",
    );
    const mismatched = { ...fixedInput(), methodologyVersion: "0.0" };
    expect(() => buildReportCardsSnapshotFromFixedInput(mismatched)).toThrow("does not match current");
    expect(() => buildReportCardsSnapshotFromFixedInput(mismatched, { allowMethodologyMismatch: true })).not.toThrow();

    const registryMismatched = { ...fixedInput(), registryFingerprint: "0".repeat(64) };
    expect(() => buildReportCardsSnapshotFromFixedInput(registryMismatched)).toThrow("registry fingerprint");
    expect(() =>
      buildReportCardsSnapshotFromFixedInput(registryMismatched, { allowRegistryMismatch: true }),
    ).not.toThrow();

    expect(() =>
      buildReportCardsSnapshotFromFixedInput({ ...fixedInput(), dexPayloadFingerprint: "0".repeat(64) }),
    ).toThrow("DEX payload fingerprint");

    expect(() =>
      buildReportCardsSnapshotFromFixedInput({ ...fixedInput(), dexGenerationId: "different-generation" }),
    ).toThrow("DEX payload fingerprint");
  });

  it("normalizes nested route, key, output, and capacity-curve ordering", () => {
    const first = route("dex:a", ["protocol:test", "chain:solana"], ["solana:MintB", "solana:MintA"]);
    const second = route("dex:b", ["chain:solana", "protocol:test"], ["solana:MintA"]);
    const left = normalizeFixedInput(fixedInput({ coin: dexRow([second, first]) }));
    const right = normalizeFixedInput(
      fixedInput({
        coin: dexRow([
          {
            ...first,
            commonModeKeys: [...first.commonModeKeys].reverse(),
            capacityCurve: [...first.capacityCurve!].reverse(),
          },
          second,
        ]),
      }),
    );

    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
  });

  it("round-trips the exact publication input through its bounded checksum envelope", async () => {
    const input = exactFixedInput();
    const entry = await buildReportCardsFixedInputCacheEntry(input);
    expect(entry.storedBytes).toBeLessThanOrEqual(1_900_000);
    await expect(parseReportCardsFixedInputCacheValue(entry.value)).resolves.toEqual(input);

    const tampered = JSON.parse(entry.value) as { payloadSha256: string };
    tampered.payloadSha256 = "0".repeat(64);
    await expect(parseReportCardsFixedInputCacheValue(JSON.stringify(tampered))).rejects.toThrow("checksum mismatch");
  });

  it("never persists a public fanout reconstruction as exact P0c evidence", async () => {
    await expect(buildReportCardsFixedInputCacheEntry(fixedInput())).rejects.toThrow("Only exact publication inputs");
  });

  it("migrates the legacy schema-v1 replay contract as an explicit reconstruction", () => {
    const current = fixedInput({ coin: dexRow([]) });
    const legacy = {
      schemaVersion: 1,
      capturedAt: current.capturedAt,
      sourceGeneration: current.sourceGeneration,
      registryRevision: current.registryRevision,
      methodologyVersion: current.methodologyVersion,
      clockSec: current.clockSec,
      updatedAt: current.updatedAt,
      liquidityStale: current.liquidityStale,
      redemptionStale: current.redemptionStale,
      inputFreshness: current.inputFreshness,
      pegDataById: current.pegDataById,
      activeDepegPeakBpsById: current.activeDepegPeakBpsById,
      dexLiqMap: { coin: dexRow([]) },
      redemptionBackstopMap: current.redemptionBackstopMap,
      bluechipMap: current.bluechipMap,
      resolvedBlacklistStatuses: current.resolvedBlacklistStatuses,
      liveReserveMap: current.liveReserveMap,
      liveReserveProvenanceMap: current.liveReserveProvenanceMap,
      chainCirculatingById: current.chainCirculatingById,
      dexDeploymentSupplyCoverageById: current.dexDeploymentSupplyCoverageById,
      collateralDriftCoins: current.collateralDriftCoins,
      liveToFallbackCoins: current.liveToFallbackCoins,
    };

    expect(normalizeFixedInput(legacy)).toMatchObject({
      schemaVersion: 3,
      captureKind: "public-reconstruction",
      dexGenerationId: "dex-liquidity-1783891100",
    });
  });

  it("rejects redemption-family observations from fixed DEX inputs", () => {
    const current = fixedInput({ coin: dexRow([]) });
    const misrouted = {
      ...route("redeem:misrouted", ["issuer:test"], []),
      routeFamily: "issuer-redemption",
      scope: { kind: "issuer", issuerId: "issuer" },
      output: { kind: "fiat", currency: "USD" },
      evidenceKind: "documented-terms",
    };

    expect(() =>
      normalizeFixedInput({
        ...current,
        dexLiqMap: {
          coin: {
            ...current.dexLiqMap.coin,
            exitRouteObservations: [misrouted],
          },
        },
      }),
    ).toThrow();
  });

  it("rejects incomplete or mixed-generation exact active DEX rows", () => {
    const complete = exactFixedInput();
    const [removedId] = complete.activeAssetIds;
    const incompleteRows = { ...complete.dexLiqMap };
    delete incompleteRows[removedId!];
    expect(() => normalizeFixedInput({ ...complete, dexLiqMap: incompleteRows })).toThrow(
      "Exact fixed input DEX active rows mismatch",
    );

    const [changedId] = complete.activeAssetIds;
    const mixedRows = {
      ...complete.dexLiqMap,
      [changedId!]: { ...complete.dexLiqMap[changedId!]!, updatedAt: complete.clockSec },
    };
    expect(() => normalizeFixedInput({ ...complete, dexLiqMap: mixedRows })).toThrow(
      "DEX rows do not match the DEX freshness generation",
    );
  });
});
