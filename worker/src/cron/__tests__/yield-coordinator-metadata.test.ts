import { describe, expect, it } from "vitest";
import { COMPARISON_ANCHOR_STALE_THRESHOLD_MS } from "../yield-helpers";
import { buildHardcodedUsdBenchmark } from "../yield-sync/benchmarks";
import {
  buildComparisonAnchorFreshnessMeta,
  buildYieldDegradationReasons,
  buildYieldSyncMetadata,
} from "../yield-sync/coordinator-metadata";
import type { EvaluatedYieldSource } from "../yield-sync/evaluation-types";
import type { YieldEnvelopeRejection } from "../yield-sync/types";

const START_SEC = 1_800_000_000;
const STALE_THRESHOLD_SEC = COMPARISON_ANCHOR_STALE_THRESHOLD_MS / 1000;

function makeEvaluatedSource(overrides: Partial<EvaluatedYieldSource>): EvaluatedYieldSource {
  return {
    id: "usdc-circle",
    symbol: "USDC",
    sourceKey: "source",
    dataSource: "onchain",
    comparisonAnchorObservedAt: null,
    ...overrides,
  } as EvaluatedYieldSource;
}

function makeEnvelopeRejection(index: number): YieldEnvelopeRejection {
  return {
    stablecoinId: `coin-${index}`,
    symbol: `C${index}`,
    sourceKey: `onchain:coin-${index}`,
    computedApy: 350 + index,
    exchangeRate: 1.2,
    previousExchangeRate: 1,
    anchorObservedAt: START_SEC - 7 * 86400,
    actualDays: 7,
  };
}

describe("buildComparisonAnchorFreshnessMeta", () => {
  it("summarizes anchored and stale comparison anchors using the shared stale threshold", () => {
    const meta = buildComparisonAnchorFreshnessMeta({
      startSec: START_SEC,
      evaluatedSources: [
        makeEvaluatedSource({
          id: "fresh",
          symbol: "FRESH",
          sourceKey: "onchain:fresh",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC,
        }),
        makeEvaluatedSource({
          id: "stale",
          symbol: "STALE",
          sourceKey: "onchain:stale",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC - 1,
        }),
        makeEvaluatedSource({
          id: "oldest",
          symbol: "OLD",
          sourceKey: "price-derived",
          dataSource: "price-derived",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC - 100,
        }),
        makeEvaluatedSource({ id: "unanchored", comparisonAnchorObservedAt: null }),
      ],
    });

    expect(meta).toMatchObject({
      anchoredRowCount: 3,
      staleAnchorCount: 1,
      oldestAnchorAgeSeconds: STALE_THRESHOLD_SEC + 100,
      oldestAnchorStablecoinId: "oldest",
      oldestAnchorSourceKey: "price-derived",
      staleAnchorExamplesTruncated: false,
    });
    expect(meta.staleAnchorExamples.map((row) => row.stablecoinId)).toEqual(["stale"]);
  });
});

describe("buildYieldDegradationReasons", () => {
  it("retains default benchmark fallback health when no source row is selected", () => {
    expect(buildYieldDegradationReasons({
      safetySnapshotDegraded: false,
      safetySnapshotReason: null,
      defaultBenchmarkMeta: buildHardcodedUsdBenchmark("fred-api-error-retained"),
      selectedSources: [],
      dlPoolsMeta: {
        mode: "dex-cache",
        updatedAt: START_SEC,
        ageSeconds: 0,
        poolCount: 0,
        fallbackMode: null,
      },
      allDeterministicFailed: false,
      maskedAllDeterministicFailure: false,
      onChainSkippedDueToCooldown: false,
      onChainAlternativeCoverageMissingIds: [],
      previousTvlRowsTruncated: false,
    })).toContain("risk-free-rate:fred-api-error-retained");
  });
});

describe("buildYieldSyncMetadata", () => {
  it("writes bounded envelope rejections and comparison-anchor freshness under sourceCoverage", () => {
    const comparisonAnchorFreshness = buildComparisonAnchorFreshnessMeta({
      startSec: START_SEC,
      evaluatedSources: [
        makeEvaluatedSource({
          id: "stale",
          symbol: "STALE",
          sourceKey: "onchain:stale",
          comparisonAnchorObservedAt: START_SEC - STALE_THRESHOLD_SEC - 1,
        }),
      ],
    });
    const envelopeRejections = Array.from({ length: 26 }, (_, index) => makeEnvelopeRejection(index));

    const metadata = JSON.parse(
      buildYieldSyncMetadata({
        rowsRead: 1,
        rowsWritten: 1,
        rowsRejected: 0,
        divergenceFlags: 0,
        sourceSwitches: 0,
        defaultSafetyCoinCount: 0,
        safetySnapshot: {
          kind: "ok",
          coverageRatio: 1,
          coveredCount: 1,
          trackedCount: 1,
          reason: null,
          source: "safety-score-v9-publication",
          publicationGenerationId: "report-cards:v8.299:1800000000",
          methodologyVersion: "v8.299",
          publishedAt: START_SEC,
        },
        resolvedYieldBearingCount: 1,
        expectedYieldBearingCount: 1,
        publishedYieldBearingCount: 1,
        previousPublishedYieldBearingCount: 1,
        publishedOpportunityCount: 0,
        previousPublishedOpportunityCount: 0,
        publishedRankingCount: 1,
        previousPublishedRankingCount: 1,
        dlPoolsMeta: {
          mode: "dex-cache",
          updatedAt: START_SEC,
          ageSeconds: 0,
          poolCount: 1,
          fallbackMode: null,
        },
        supplementalMeta: {
          mode: "cache",
          updatedAt: START_SEC,
          ageSeconds: 0,
          sourceCount: 0,
          fallbackMode: null,
        },
        onChain: {
          ratesResolved: 0,
          ratesConfigured: 1,
          envelopeRejections,
          attempted: 1,
          allDeterministicFailed: false,
          explorerAttempted: 0,
          explorerResolved: 0,
          failureMaskedByAlternativeCoverage: false,
          alternativeCoverageMissingIds: [],
          failures: null,
          skippedDueToCooldown: false,
          cooldownActive: false,
          cooldownTriggered: false,
          cooldownUntil: null,
          cooldownRemainingSec: 0,
          consecutiveAllFailRuns: 0,
          consecutiveMaskedAllFailRuns: 0,
        },
        fallbackMode: null,
        validationFailures: 0,
        riskFreeRate: 4,
        cacheWriteSkipped: false,
        comparisonAnchorFreshness,
        previousTvlRowsTruncated: true,
      }),
    ) as {
      sourceCoverage: {
        publishedRankingCountDelta: number;
        onChainEnvelopeRejectionCount: number;
        onChainEnvelopeRejections: YieldEnvelopeRejection[];
        onChainEnvelopeRejectionsTruncated: boolean;
        comparisonAnchorFreshness: typeof comparisonAnchorFreshness;
        previousTvlRowsTruncated: boolean;
        safetySnapshot: {
          source: string;
          publicationGenerationId: string;
          methodologyVersion: string;
          publishedAt: number;
        };
      };
    };

    expect(metadata.sourceCoverage.onChainEnvelopeRejectionCount).toBe(26);
    expect(metadata.sourceCoverage.publishedRankingCountDelta).toBe(0);
    expect(metadata.sourceCoverage.onChainEnvelopeRejections).toHaveLength(25);
    expect(metadata.sourceCoverage.onChainEnvelopeRejections[0]).toEqual(envelopeRejections[0]);
    expect(metadata.sourceCoverage.onChainEnvelopeRejectionsTruncated).toBe(true);
    expect(metadata.sourceCoverage.comparisonAnchorFreshness).toEqual(comparisonAnchorFreshness);
    expect(metadata.sourceCoverage.previousTvlRowsTruncated).toBe(true);
    expect(metadata.sourceCoverage.safetySnapshot).toMatchObject({
      source: "safety-score-v9-publication",
      publicationGenerationId: "report-cards:v8.299:1800000000",
      methodologyVersion: "v8.299",
      publishedAt: START_SEC,
    });
  });
});
