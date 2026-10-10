import { describe, expect, it } from "vitest";

import { buildDexLiquidityCronMetadata } from "../dex-liquidity/orchestrator-metadata";
import { initLiquidityFallbackCounters } from "../dex-liquidity/pool-helpers";
import type { DexLiquidityPostScoreAnalysis } from "../dex-liquidity/orchestrator-analysis";
import type { DexPricePersistenceDiagnostics } from "../dex-liquidity/scoring";
import { DexLiquidityCronMetadataSchema } from "../../lib/schemas";

function metadataParams(): Parameters<typeof buildDexLiquidityCronMetadata>[0] {
  return {
    sourceState: {
      primaryRawPoolCount: 4_000,
      failedSources: [],
      fallbackSignals: [],
      directApiSourceSummary: { circuitEvents: [], sourceWarnings: [], pagination: [] },
    },
    poolState: {
      stagedMergedCount: 0,
      stagedSkippedCount: 0,
      stagedSkippedByExactIdentityCount: 0,
      stagedSkippedByUniqueDerivedIdentityCount: 0,
      stagedSkippedByOptionalWildcardIdentityCount: 0,
      stagedSkippedByAuthoritativeProtocolCount: 0,
      stagedSkipDimensions: [],
      poolRejections: [],
      directApiIntegration: { acceptedByProtocolChain: {}, excludedByReason: {} },
      deadPoolUnindexedChainSkips: {},
    },
    scoreState: {
      scoreResults: { size: 300 },
      analysis: { sourceCoverage: {} as DexLiquidityPostScoreAnalysis["sourceCoverage"] },
      diagnostics: {
        fallbackCounters: initLiquidityFallbackCounters(),
        deadPoolExclusions: {
          reason: "dead-pool-zero-trade-untracked-counter",
          thresholdTvlUsd: 1_000_000,
          poolCount: 0,
          tvlUsd: 0,
          topStablecoins: [],
        },
      },
    },
    persistenceState: {
      challengerPublication: { publishedStablecoins: 0, skippedStablecoins: 0 },
      dexPriceDiagnostics: {} as DexPricePersistenceDiagnostics,
      persistence: {
        placeholderCount: 0,
        inactiveMetricRowsSkipped: 0,
        orphanRowsDeleted: 0,
        orphanCleanupFailed: false,
      },
      historicalSnapshot: {
        snapshotRowsWritten: 0,
        skipped: false,
        writeFailed: false,
        historyRowsPruned: 0,
        retentionPruneFailed: false,
      },
    },
  };
}

describe("dex liquidity cron metadata", () => {
  it("aggregates rejection groups and applies aggregate TVL materiality", () => {
    const params = metadataParams();
    params.poolState.poolRejections = [
      { reason: "invalid-pool-identity", poolIds: ["a", "b"], count: 2, tvlUsd: 600_000 },
      { reason: "invalid-pool-volume", poolIds: ["c"], count: 1, tvlUsd: 400_000 },
    ];
    const metadata = buildDexLiquidityCronMetadata(params);
    expect(metadata).toMatchObject({
      rowsDropped: 3,
      poolRejectionMateriality: { rejectedPoolCount: 3, rejectedPoolTvlUsd: 1_000_000, material: true },
    });
  });

  it("deduplicates failures and fallback signals without dropping distinct identities", () => {
    const params = metadataParams();
    params.sourceState.failedSources = ["curve", "raydium", "curve"];
    params.sourceState.fallbackSignals = ["gecko", "orderbook", "gecko"];
    expect(buildDexLiquidityCronMetadata(params)).toMatchObject({
      failedSources: ["curve", "raydium"], fallbackMode: ["gecko", "orderbook"],
    });
  });

  it("bounds inactive diagnostics while retaining the full skipped count", () => {
    const params = metadataParams();
    params.persistenceState.persistence.inactiveMetricIdsSkipped = Array.from({ length: 30 }, (_, i) => `inactive-${i}`);
    params.persistenceState.persistence.inactiveMetricRowsSkipped = 30;
    expect(buildDexLiquidityCronMetadata(params).persistence).toMatchObject({
      inactiveMetricRowsSkipped: 30,
      inactiveMetricIdsSkipped: Array.from({ length: 25 }, (_, i) => `inactive-${i}`),
    });
  });

  it("preserves registry and step attribution through the typed metadata reader", () => {
    const params = metadataParams();
    params.poolState.registryRowsRead = 900;
    params.poolState.registryMultiSourcePools = 100;
    params.poolState.registryFamilyBySource = { dl: 500, cg_onchain: 400 };
    params.poolState.stagedMergedCount = 400;
    Object.assign(params.scoreState.analysis.sourceCoverage, {
      coinTvlStepCount150: 51,
      coinTvlStepCount25: 52,
      coinTvlStepIds150: ["tiny"],
      coinTvlStepIds150Omitted: 50,
      coinTvlStepIds25: ["tiny", "small"],
      coinTvlStepIds25Omitted: 50,
      coinTvlStepComparisons: 100,
      coinTvlStepMissingBaseline: 2,
      coinTvlStepMissingCurrent: 3,
      coinTvlStepBaselineUnavailable: false,
      coinTvlStepTop: [{
        stablecoinId: "large", previousTvlUsd: 100, currentTvlUsd: 160,
        ratio: 1.6, protocol: null, protocolDeltaUsd: null,
      }],
    });
    const parsed = DexLiquidityCronMetadataSchema.parse(buildDexLiquidityCronMetadata(params));
    expect(parsed).toMatchObject({
      stagedPoolsMerged: 400,
      registryRowsRead: 900,
      registryMultiSourcePools: 100,
      registryFamilyBySource: { dl: 500, cg_onchain: 400 },
      sourceCoverage: params.scoreState.analysis.sourceCoverage,
    });
    const cost = { queries: 10, rowsRead: 1_000, rowsWritten: 20, coverage: "partial", reasons: ["first-no-meta"] };
    expect(DexLiquidityCronMetadataSchema.parse({ d1Cost: cost }).d1Cost).toEqual(cost);
  });

  it.each([
    [false, undefined, 300],
    [true, "source-incomplete", 0],
    [false, "liquidity-cadence-reuse", 0],
  ] as const)("projects written rows for skipped=%s reason=%s", (skipped, skippedReason, rowsWritten) => {
    const params = metadataParams();
    Object.assign(params.persistenceState.persistence, { skipped, skippedReason });
    const metadata = JSON.parse(JSON.stringify(buildDexLiquidityCronMetadata(params)));
    expect(metadata).toMatchObject({ rowsRead: 4_000, rowsWritten, persistence: { skipped, skippedReason: skippedReason ?? null } });
    expect(metadata).not.toHaveProperty("registryEvaluation");
  });

  it("serializes the explicit source summary and optional registry diagnostics", () => {
    const params = metadataParams();
    params.poolState.registryEvaluatedAtSec = 123;
    params.poolState.directApiIntegration.acceptedByProtocolChain = { "orca:solana": 2 };
    params.sourceState.directApiSourceSummary.sourceWarnings = ["orca-partial"];
    params.sourceState.degradedSources = ["orca:solana", "orca:solana"];
    const metadata = JSON.parse(JSON.stringify(buildDexLiquidityCronMetadata(params)));
    expect(metadata).toMatchObject({
      registryEvaluation: { evaluatedAtSec: 123, basis: "registry-read-consumed" },
      degradedSources: ["orca:solana"],
      directApiSourceSummary: {
        acceptedByProtocolChain: { "orca:solana": 2 }, excludedByReason: {},
        circuitEvents: [], sourceWarnings: ["orca-partial"], pagination: [],
      },
    });
    expect(Object.keys(metadata.directApiSourceSummary)).toEqual([
      "acceptedByProtocolChain", "excludedByReason", "circuitEvents", "sourceWarnings", "pagination",
    ]);
    expect(DexLiquidityCronMetadataSchema.parse(metadata).registryEvaluation).toEqual(metadata.registryEvaluation);
  });
});
