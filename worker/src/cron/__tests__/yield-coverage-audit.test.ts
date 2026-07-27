import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
}));
vi.mock("../yield-sync/sources", () => ({
  loadDlStablecoinPools: vi.fn(),
}));
vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(),
  setCache: vi.fn(),
}));
vi.mock("../../lib/safety-scores", () => ({
  computeSafetyScoresSnapshot: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { getCache, setCache } from "../../lib/db-cache";
import { computeSafetyScoresSnapshot } from "../../lib/safety-scores";
import type { CronProgressUpdate } from "../../lib/cron-logger";
import {
  buildProtocolCategoryLookupFromCachePayload,
  buildCoverageAuditOperatorQueue,
  identifyCoverageGaps,
  identifyStaleAutoLendingOverrides,
  isHighConfidenceProtocolCategory,
  runYieldCoverageAudit,
  summarizeAdapterLifecycle,
} from "../yield-coverage-audit";
import { probeQuarantinedDeterministicAdapters } from "../yield-coverage-audit-quarantine";
import { loadDlStablecoinPools } from "../yield-sync/sources";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { YieldAdapterLifecycleEntry } from "../yield-config-registry";
import type { DlPool } from "../yield-sync/types";
import { buildYieldCoverageEvidenceFingerprint } from "../yield-coverage-review-dispositions";

const mockFetchEvmUint256AtBlock = vi.mocked(fetchEvmUint256AtBlock);
const mockLoadDlStablecoinPools = vi.mocked(loadDlStablecoinPools);
const mockGetCache = vi.mocked(getCache);
const mockSetCache = vi.mocked(setCache);
const mockComputeSafetyScoresSnapshot = vi.mocked(computeSafetyScoresSnapshot);

function v8Identity() {
  return {
    model: "v8" as const,
    schemaVersion: 1 as const,
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    evaluationBuildDigest: "a".repeat(64),
    baseInputGenerationId: `report-cards-input:v1:${"b".repeat(64)}`,
    publicationGenerationId: `report-cards:${SAFETY_SCORE_METHODOLOGY_VERSION}:1774526300`,
  };
}

afterEach(() => {
  mockFetchEvmUint256AtBlock.mockReset();
  mockLoadDlStablecoinPools.mockReset();
  mockGetCache.mockReset();
  mockSetCache.mockReset();
  mockComputeSafetyScoresSnapshot.mockReset();
});

function inferExpectedProtocolLabel(project: string): string {
  return project
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

describe("buildProtocolCategoryLookupFromCachePayload", () => {
  it("parses compact cached DeFiLlama protocol category payloads by normalized slug", () => {
    const lookup = buildProtocolCategoryLookupFromCachePayload({
      protocols: [
        { slug: "Aave-V3", category: " Lending " },
        { slug: "curve-dex", category: "Dexs" },
        { slug: "missing-category" },
        { slug: "blank-category", category: " " },
        { category: "CDP" },
      ],
    });

    expect(lookup).toEqual(new Map([
      ["aave-v3", "Lending"],
      ["curve-dex", "Dexs"],
    ]));
  });

  it("accepts the allowed lending categories for high-confidence recommendations", () => {
    expect(isHighConfidenceProtocolCategory("Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("CDP")).toBe(true);
    expect(isHighConfidenceProtocolCategory("RWA Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("Uncollateralized Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("Yield Aggregator")).toBe(false);
    expect(isHighConfidenceProtocolCategory(null)).toBe(false);
  });
});

describe("runYieldCoverageAudit", () => {
  it("defers when the compact safety snapshot is not complete and never requests computed V8 scores", async () => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [{
        pool: "new-usdc", chain: "Ethereum", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000,
        apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null,
      }],
      meta: { mode: "dex-cache", updatedAt: 1_774_526_300, ageSeconds: 100, poolCount: 1, fallbackMode: null },
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue({
      kind: "degraded",
      mode: "map",
      coveredCount: 0,
      trackedCount: 1,
      coverageRatio: 0,
      reason: "safety-score-v9-publication:completeness-mismatch",
      scores: new Map(),
      source: "safety-score-v9-publication",
      expectedModel: "v8",
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    } as never);

    const result = await runYieldCoverageAudit(mockD1());

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "safety-snapshot-unavailable:safety-score-v9-publication:completeness-mismatch",
      expectedModel: "v8",
    });
    expect(mockComputeSafetyScoresSnapshot).toHaveBeenCalledOnce();
    expect(mockComputeSafetyScoresSnapshot).toHaveBeenCalledWith(expect.anything(), {
      outputMode: "map",
      sourceMode: "published-cache",
    });
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it.each([
    ["active V9 marker", "active-safety-score:v9"],
    ["malformed V9 marker", "active-safety-score:activation-marker-invalid"],
    ["mismatched V9 identity", "active-safety-score:v9-identity-mismatch"],
  ])("defers with explicit V9 provenance for %s", async (_label, reason) => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [{
        pool: "new-usdc", chain: "Ethereum", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000,
        apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null,
      }],
      meta: { mode: "dex-cache", updatedAt: 1_774_526_300, ageSeconds: 100, poolCount: 1, fallbackMode: null },
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue({
      kind: "degraded",
      mode: "map",
      coveredCount: 0,
      trackedCount: 1,
      coverageRatio: 0,
      reason,
      scores: new Map(),
      source: "safety-score-v9-publication",
      expectedModel: "v9",
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    } as never);

    const result = await runYieldCoverageAudit(mockD1());

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: `safety-snapshot-unavailable:${reason}`,
      expectedModel: "v9",
      safetyScoreIdentity: null,
    });
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it("reports bounded progress stages through cache publication", async () => {
    const dlPools: DlPool[] = [{
      pool: "new-usdc",
      chain: "Ethereum",
      project: "new-lender",
      symbol: "USDC",
      tvlUsd: 12_000_000,
      apy: 4,
      apyBase: 4,
      apyReward: null,
      apyMean30d: 4,
      stablecoin: true,
      exposure: "single",
      underlyingTokens: null,
    }];
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: dlPools,
      meta: {
        mode: "dex-cache",
        updatedAt: 1_774_526_300,
        ageSeconds: 100,
        poolCount: 1,
        fallbackMode: null,
      },
    });
    mockGetCache.mockImplementation(async (_db, key) => {
      if (key === "defillama-protocols") {
        return {
          value: JSON.stringify({ protocols: [{ slug: "new-lender", category: "Lending" }] }),
          updatedAt: 1_774_526_300,
        };
      }
      if (key === "yield-rankings") {
        return { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 };
      }
      if (key === "report_card_cache") {
        return {
          value: JSON.stringify({
            scores: {
              "dllr-sovryn": { score: 49, grade: "D" },
            },
            updatedAt: Math.floor(Date.now() / 1000),
            methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
          }),
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
      return null;
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map(),
      source: "safety-score-v9-publication",
      expectedModel: "v8",
      safetyScoreIdentity: v8Identity(),
      publicationGenerationId: v8Identity().publicationGenerationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: Math.floor(Date.now() / 1000),
    } as never);

    const expectedQueue = buildCoverageAuditOperatorQueue({
      gaps: identifyCoverageGaps(
        dlPools,
        new Set(),
        undefined,
        new Map([["new-lender", "Lending"]]),
      ),
      manifestMissingIds: [],
      yieldBearingMissingFromRankings: [],
      staleVenueRiskScores: [],
    });
    const reviewedItem = expectedQueue.recommendationCandidates.find(
      (item) => item.id === "lending-allowlist:new-lender",
    );
    expect(reviewedItem).toBeDefined();
    const nowSec = Math.floor(Date.now() / 1_000);
    const db = mockD1([{
      match: "yield_coverage_review_dispositions",
      rows: reviewedItem ? [{
        queue_item_id: reviewedItem.id,
        queue_item_kind: reviewedItem.kind,
        evidence_fingerprint: buildYieldCoverageEvidenceFingerprint(reviewedItem),
        disposition: "watch",
        evidence: "Reviewed protocol category and pool identity.",
        review_owner: "yield-review",
        reviewed_at: nowSec - 60,
        next_review_at: nowSec + 3_600,
        expires_at: nowSec + 7_200,
      }] : [],
    }]);
    const progressUpdates: CronProgressUpdate[] = [];
    const result = await runYieldCoverageAudit(db, undefined, undefined, async (update) => {
      progressUpdates.push(update);
    });

    expect(result.status).toBe("ok");
    expect(mockSetCache).toHaveBeenCalledWith(
      db,
      "yield-coverage-audit",
      expect.stringContaining('"reportedAt"'),
    );
    const cachedReport = JSON.parse(String(mockSetCache.mock.calls[0]?.[2])) as {
      operatorQueue: {
        persistence: string;
        promotionMode: string;
        suppressedItemCount: number;
        recommendationCandidates: Array<{ id: string }>;
      };
      operatorReviewSummary: { suppressedItemCount: number };
    };
    expect(cachedReport.operatorQueue).toMatchObject({
      persistence: "durable",
      promotionMode: "human-reviewed",
      suppressedItemCount: 1,
    });
    expect(cachedReport.operatorQueue.recommendationCandidates).not.toContainEqual(
      expect.objectContaining({ id: "lending-allowlist:new-lender" }),
    );
    expect(cachedReport.operatorReviewSummary.suppressedItemCount).toBe(1);
    expect(progressUpdates.map((update) => update.stage)).toEqual(
      expect.arrayContaining([
        "pool-load",
        "protocol-category-load",
        "safety-supply-load",
        "quarantine-probe",
        "cache-write",
        "complete",
      ]),
    );
    expect(progressUpdates.every((update) => update.itemsTotal === 6)).toBe(true);
    expect(progressUpdates.find((update) => update.stage === "pool-load" && update.itemsDone === 1)).toMatchObject({
      metadata: {
        providerFamily: "yield-coverage-audit",
        phase: "pool-load",
        countTotals: { dlPools: 1 },
      },
    });
    expect(progressUpdates.find((update) => update.stage === "protocol-category-load" && update.itemsDone === 2))
      .toMatchObject({
        metadata: {
          providerFamily: "yield-coverage-audit",
          phase: "protocol-category-load",
          protocolCategoryStatus: "ok",
          countTotals: {
            protocols: 1,
            categorizedProtocols: 1,
            highConfidenceCategories: 1,
          },
        },
      });
    expect(progressUpdates.find((update) => update.stage === "safety-supply-load" && update.itemsDone === 3))
      .toMatchObject({
        metadata: {
          providerFamily: "yield-coverage-audit",
          phase: "safety-supply-load",
          countTotals: {
            stablecoinSupplyRows: 0,
            safetyScoresComputed: 1,
            safetyScoresExpected: 1,
          },
          safetySnapshotSource: "safety-score-v9-publication",
        },
      });
    expect(mockComputeSafetyScoresSnapshot).toHaveBeenCalledWith(db, {
      outputMode: "map",
      sourceMode: "published-cache",
    });
    expect(progressUpdates.find((update) => update.stage === "quarantine-probe" && update.itemsDone === 4))
      .toMatchObject({
        metadata: {
          providerFamily: "yield-coverage-audit",
          phase: "quarantine-probe",
          countTotals: {
            quarantineProbeAttempted: 0,
          },
        },
      });
    expect(progressUpdates[progressUpdates.length - 1]).toMatchObject({
      stage: "complete",
      itemsDone: 6,
      metadata: {
        cacheKey: "yield-coverage-audit",
      },
    });
  });

  it("returns degraded when protocol-category cache is unavailable", async () => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [{
        pool: "new-usdc",
        chain: "Ethereum",
        project: "new-lender",
        symbol: "USDC",
        tvlUsd: 12_000_000,
        apy: 4,
        apyBase: 4,
        apyReward: null,
        apyMean30d: 4,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: null,
      }],
      meta: {
        mode: "dex-cache",
        updatedAt: 1_774_526_300,
        ageSeconds: 100,
        poolCount: 1,
        fallbackMode: null,
      },
    });
    mockGetCache.mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 };
      }
      return null;
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue({
      kind: "ok",
      mode: "map",
      coveredCount: 1,
      trackedCount: 1,
      coverageRatio: 1,
      scores: new Map(),
      source: "safety-score-v9-publication",
      expectedModel: "v8",
      safetyScoreIdentity: v8Identity(),
      publicationGenerationId: v8Identity().publicationGenerationId,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      publishedAt: Math.floor(Date.now() / 1000),
    } as never);

    const result = await runYieldCoverageAudit(mockD1([{
      match: "yield_coverage_review_dispositions",
      rows: [],
    }]));
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason?: string;
      protocolCategoryStatus?: string;
    };

    expect(result.status).toBe("degraded");
    expect(metadata).toMatchObject({
      reason: "protocol-category-cache-missing",
      protocolCategoryStatus: "missing",
    });
    expect(mockSetCache).toHaveBeenCalled();
  });
});

describe("identifyCoverageGaps", () => {
  it("identifies high-TVL stablecoin pools not matched", () => {
    const dlPools: DlPool[] = [{
      pool: "unknown-pool", chain: "Ethereum", project: "new-protocol",
      symbol: "NEW_STABLE", tvlUsd: 50_000_000, apy: 5, apyBase: 5,
      apyReward: null, apyMean30d: 5, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.unmatchedHighTvlPools.length).toBe(1);
    expect(gaps.unmatchedHighTvlPools[0].pool).toBe("unknown-pool");
  });

  it("does not flag pools already covered", () => {
    const dlPools: DlPool[] = [{
      pool: "covered-pool", chain: "Ethereum", project: "aave-v3",
      symbol: "USDC", tvlUsd: 100_000_000, apy: 3, apyBase: 3,
      apyReward: null, apyMean30d: 3, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const gaps = identifyCoverageGaps(dlPools, new Set(["covered-pool"]));
    expect(gaps.unmatchedHighTvlPools.length).toBe(0);
  });

  it("identifies protocols not in allowlist", () => {
    const dlPools: DlPool[] = [{
      pool: "p1", chain: "Ethereum", project: "brand-new-protocol",
      symbol: "USDC", tvlUsd: 10_000_000, apy: 4, apyBase: 4,
      apyReward: null, apyMean30d: 4, stablecoin: true,
      exposure: "single", underlyingTokens: null,
    }];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.missingProtocols.length).toBeGreaterThan(0);
    expect(gaps.missingProtocols[0].project).toBe("brand-new-protocol");
  });

  it("does not flag high-TVL pools on already-supported allowlisted protocols as unmatched gaps", () => {
    const dlPools: DlPool[] = [{
      pool: "aave-pool",
      chain: "Ethereum",
      project: "aave-v3",
      symbol: "USDC",
      tvlUsd: 100_000_000,
      apy: 3,
      apyBase: 3,
      apyReward: null,
      apyMean30d: 3,
      stablecoin: true,
      exposure: "single",
      underlyingTokens: null,
    }];

    const gaps = identifyCoverageGaps(dlPools, new Set(), new Set(["aave-v3"]));
    expect(gaps.unmatchedHighTvlPools).toEqual([]);
    expect(gaps.missingProtocols).toEqual([]);
  });

  it("recommends high-confidence protocols with >$10M TVL and 3+ pools", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "rising-protocol", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p2", chain: "Ethereum", project: "rising-protocol", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p3", chain: "Arbitrum", project: "rising-protocol", symbol: "USDC", tvlUsd: 3_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];
    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([["rising-protocol", "Lending"]]),
    );
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "rising-protocol",
        protocolCategory: "Lending",
        totalTvlUsd: 11_000_000,
        recommendedTier: "high-confidence",
      }),
    );
  });

  it("carries provided protocol category metadata on recommendations", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "category-lender", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p2", chain: "Ethereum", project: "category-lender", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p3", chain: "Arbitrum", project: "category-lender", symbol: "DAI", tvlUsd: 3_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([["category-lender", "Lending"]]),
    );

    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "category-lender",
        protocolCategory: "Lending",
        recommendedTier: "high-confidence",
      }),
    );
  });

  it("requires an allowed lending category before assigning high-confidence", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "aggregator-protocol", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p2", chain: "Ethereum", project: "aggregator-protocol", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p3", chain: "Arbitrum", project: "aggregator-protocol", symbol: "DAI", tvlUsd: 4_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p4", chain: "Ethereum", project: "missing-category-protocol", symbol: "USDC", tvlUsd: 4_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p5", chain: "Ethereum", project: "missing-category-protocol", symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyReward: null, apyMean30d: 3.5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "p6", chain: "Arbitrum", project: "missing-category-protocol", symbol: "DAI", tvlUsd: 4_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([["aggregator-protocol", "Yield Aggregator"]]),
    );

    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "aggregator-protocol",
        protocolCategory: "Yield Aggregator",
        recommendedTier: "review-needed",
      }),
    );
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "missing-category-protocol",
        protocolCategory: null,
        recommendedTier: "review-needed",
      }),
    );
  });

  it("splits source-family adapter and lending allowlist recommendations", () => {
    const dlPools: DlPool[] = [
      { pool: "morpho-usdc", chain: "Ethereum", project: "morpho-blue", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "new-usdc", chain: "Ethereum", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      new Set(["morpho-blue"]),
      new Map([["new-lender", "Lending"]]),
    );

    expect(gaps.sourceFamilyAdapterRecommendations).toContainEqual(
      expect.objectContaining({
        project: "morpho-blue",
        totalTvlUsd: 12_000_000,
      }),
    );
    expect(gaps.lendingAllowlistRecommendations).toContainEqual(
      expect.objectContaining({
        project: "new-lender",
        protocolCategory: "Lending",
        totalTvlUsd: 12_000_000,
        sourceLinks: expect.arrayContaining([
          expect.objectContaining({ url: "https://yields.llama.fi/chart/new-usdc" }),
        ]),
        suggestedConfig: expect.objectContaining({
          targetFile: "worker/src/cron/yield-config-lending-protocols.ts",
          exportName: "LENDING_PROTOCOLS",
          anchor: "YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR",
          snippet: expect.stringContaining('"new-lender": { label: "New Lender" }'),
        }),
        promotionMetadata: expect.objectContaining({
          sourceQueue: "monthly-unmatched-high-tvl",
          sourceQueueField: "unmatchedHighTvlPools",
          minPoolTvlUsd: 5_000_000,
          queueQualifiedPoolCount: 1,
          passedCategoryGate: true,
          existingAllowlistMember: false,
        }),
      }),
    );
    expect(gaps.lendingAllowlistRecommendations).not.toContainEqual(
      expect.objectContaining({ project: "morpho-blue" }),
    );
  });

  it("surfaces allowlisted high-TVL venue slugs missing risk registry aliases", () => {
    const dlPools: DlPool[] = [
      {
        pool: "aave-usdc",
        chain: "Ethereum",
        project: "aave",
        symbol: "USDC",
        tvlUsd: 25_000_000,
        apy: 3,
        apyBase: 3,
        apyReward: null,
        apyMean30d: 3,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: null,
      },
      {
        pool: "renamed-usdc",
        chain: "Ethereum",
        project: "renamed-aave-v3",
        symbol: "USDC",
        tvlUsd: 25_000_000,
        apy: 3,
        apyBase: 3,
        apyReward: null,
        apyMean30d: 3,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: null,
      },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      new Set(["aave", "renamed-aave-v3"]),
      new Map([
        ["aave", "Lending"],
        ["renamed-aave-v3", "Lending"],
      ]),
    );

    expect(gaps.venueRiskConfigMissing).toEqual([
      expect.objectContaining({
        project: "renamed-aave-v3",
        protocolCategory: "Lending",
        poolCount: 1,
        totalTvlUsd: 25_000_000,
        examplePools: ["renamed-usdc"],
      }),
    ]);
  });

  it("escapes provider slugs in suggested lending allowlist snippets", () => {
    const maliciousProject = 'evil"\n  __pwned__: (() => { throw new Error("injected"); })(),\n  "tail';
    const dlPools: DlPool[] = [
      {
        pool: "evil-usdc",
        chain: "Ethereum",
        project: maliciousProject,
        symbol: "USDC",
        tvlUsd: 12_000_000,
        apy: 4,
        apyBase: 4,
        apyReward: null,
        apyMean30d: 4,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: null,
      },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      new Set(),
      new Map([[maliciousProject.trim().toLowerCase(), "Lending"]]),
    );

    expect(gaps.lendingAllowlistRecommendations).toContainEqual(
      expect.objectContaining({
        project: maliciousProject,
        suggestedConfig: expect.objectContaining({
          snippet: `  ${JSON.stringify(maliciousProject)}: { label: ${JSON.stringify(
            inferExpectedProtocolLabel(maliciousProject),
          )} },`,
        }),
      }),
    );
    expect(gaps.lendingAllowlistRecommendations[0]?.suggestedConfig?.snippet).toMatch(/^  "evil\\"/u);
  });

  it("drives lending allowlist recommendations from the high-TVL queue and category gate", () => {
    const dlPools: DlPool[] = [
      { pool: "queued-usdc", chain: "Ethereum", project: "queued-lender", symbol: "USDC", tvlUsd: 6_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregate-a", chain: "Ethereum", project: "aggregate-only-lender", symbol: "USDC", tvlUsd: 2_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregate-b", chain: "Base", project: "aggregate-only-lender", symbol: "USDC", tvlUsd: 2_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregate-c", chain: "Arbitrum", project: "aggregate-only-lender", symbol: "USDT", tvlUsd: 2_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "aggregator-usdc", chain: "Ethereum", project: "yield-aggregator", symbol: "USDC", tvlUsd: 20_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "missing-category-usdc", chain: "Ethereum", project: "missing-category-lender", symbol: "USDC", tvlUsd: 20_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];

    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      undefined,
      new Map([
        ["queued-lender", "Lending"],
        ["aggregate-only-lender", "Lending"],
        ["yield-aggregator", "Yield Aggregator"],
      ]),
    );

    expect(gaps.lendingAllowlistRecommendations.map((row) => row.project)).toEqual(["queued-lender"]);
    expect(gaps.lendingAllowlistRecommendations[0]).toMatchObject({
      recommendedTier: "review-needed",
      promotionMetadata: expect.objectContaining({
        queueQualifiedPoolCount: 1,
        passedCategoryGate: true,
      }),
    });
    expect(gaps.protocolRecommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ project: "aggregate-only-lender" }),
        expect.objectContaining({ project: "yield-aggregator" }),
        expect.objectContaining({ project: "missing-category-lender" }),
      ]),
    );
  });

  it("recommends native exact pools for tracked yield-bearing symbols", () => {
    const dlPools: DlPool[] = [{
      pool: "susde-native",
      chain: "Ethereum",
      project: "ethena",
      symbol: "sUSDe",
      tvlUsd: 50_000_000,
      apy: 5,
      apyBase: 5,
      apyReward: null,
      apyMean30d: 5,
      stablecoin: true,
      exposure: "single",
      underlyingTokens: null,
    }];

    const gaps = identifyCoverageGaps(dlPools, new Set());

    expect(gaps.nativeExactPoolRecommendations).toContainEqual(
      expect.objectContaining({
        pool: "susde-native",
        stablecoinIds: expect.arrayContaining(["susde-ethena"]),
      }),
    );
  });

  it("marks review-needed for protocols with <$10M TVL or <3 pools", () => {
    const dlPools: DlPool[] = [
      { pool: "p1", chain: "Ethereum", project: "small-protocol", symbol: "USDC", tvlUsd: 6_000_000, apy: 3, apyBase: 3, apyReward: null, apyMean30d: 3, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "small-protocol",
        recommendedTier: "review-needed",
      }),
    );
  });

  it("flags deterministic auto-lending overrides that no longer pass static venue gates", () => {
    const stale = identifyStaleAutoLendingOverrides([
      {
        pool: "be50b874-8147-440d-b8ca-f2c202e9ed64",
        chain: "Flare",
        project: "clearpool-lending",
        symbol: "USDX",
        tvlUsd: 1,
        apy: 0.01,
        apyBase: 0.01,
        apyReward: null,
        apyMean30d: 0.01,
        stablecoin: true,
        exposure: "single",
        underlyingTokens: ["0x4a771cc1a39fdd8aa08b8ea51f7fd412e73b3d2b"],
      },
    ]);

    expect(stale).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdx-hex-trust",
        pool: "be50b874-8147-440d-b8ca-f2c202e9ed64",
        reasons: expect.arrayContaining(["below-apy-floor", "below-tvl-floor"]),
      }),
    );
  });

  it("applies the same supply-relative TVL floor as hourly auto-lending publication", () => {
    const stale = identifyStaleAutoLendingOverrides(
      [
        {
          pool: "be50b874-8147-440d-b8ca-f2c202e9ed64",
          chain: "Flare",
          project: "clearpool-lending",
          symbol: "USDX",
          tvlUsd: 500_000,
          apy: 5,
          apyBase: 5,
          apyReward: null,
          apyMean30d: 5,
          stablecoin: true,
          exposure: "single",
          underlyingTokens: ["0x4a771cc1a39fdd8aa08b8ea51f7fd412e73b3d2b"],
        },
      ],
      {
        stablecoinSupplyById: new Map([["usdx-hex-trust", 1_000_000_000]]),
      },
    );

    expect(stale).toContainEqual(
      expect.objectContaining({
        stablecoinId: "usdx-hex-trust",
        requiredMinTvlUsd: 1_000_000,
        reasons: expect.arrayContaining(["below-tvl-floor"]),
      }),
    );
  });

  it("flags deterministic auto-lending overrides that no longer pass the safety gate", () => {
    const stale = identifyStaleAutoLendingOverrides(
      [
        {
          pool: "436e4129-667b-44d6-8322-ea59ce9b587c",
          chain: "Ethereum",
          project: "aave-v3",
          symbol: "DLLR",
          tvlUsd: 2_000_000,
          apy: 5,
          apyBase: 5,
          apyReward: null,
          apyMean30d: 5,
          stablecoin: true,
          exposure: "single",
          underlyingTokens: null,
        },
      ],
      {
        stablecoinSupplyById: new Map([["dllr-sovryn", 1_000_000]]),
        safetyScores: new Map([["dllr-sovryn", { score: 49 }]]),
      },
    );

    expect(stale).toContainEqual(
      expect.objectContaining({
        stablecoinId: "dllr-sovryn",
        reasons: expect.arrayContaining(["below-safety-score"]),
      }),
    );
  });

  it("builds a transient operator queue from headline gaps and recommendation candidates", () => {
    const dlPools: DlPool[] = [
      { pool: "susde-native", chain: "Ethereum", project: "ethena", symbol: "sUSDe", tvlUsd: 50_000_000, apy: 5, apyBase: 5, apyReward: null, apyMean30d: 5, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "morpho-usdc", chain: "Ethereum", project: "morpho-blue", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "new-usdc", chain: "Ethereum", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
      { pool: "renamed-usdc", chain: "Ethereum", project: "renamed-aave-v3", symbol: "USDC", tvlUsd: 12_000_000, apy: 4, apyBase: 4, apyReward: null, apyMean30d: 4, stablecoin: true, exposure: "single", underlyingTokens: null },
    ];
    const gaps = identifyCoverageGaps(
      dlPools,
      new Set(),
      new Set(["morpho-blue", "renamed-aave-v3"]),
      new Map([["new-lender", "Lending"], ["renamed-aave-v3", "Lending"]]),
    );

    const queue = buildCoverageAuditOperatorQueue({
      gaps,
      manifestMissingIds: ["missing-manifest"],
      yieldBearingMissingFromRankings: ["missing-ranking"],
      staleAutoLendingOverrides: [{
        stablecoinId: "usdx-hex-trust",
        pool: "stale-usdx",
        reasons: ["missing-pool"],
        project: null,
        symbol: null,
        chain: null,
        tvlUsd: null,
        apy: null,
        requiredMinTvlUsd: null,
      }],
      staleVenueRiskScores: [{
        protocol: "aave-v3",
        reviewedAt: "2026-05-15",
        ageDays: 109,
        confidence: "verified",
      }],
    });

    expect(queue).toMatchObject({
      persistence: "deferred",
      allowedActions: ["accept", "dismiss", "intentional-gap", "watch"],
    });
    expect(queue.headlineGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "manifest-missing", actionHint: "accept" }),
        expect.objectContaining({ kind: "ranking-missing", actionHint: "watch" }),
        expect.objectContaining({ kind: "stale-auto-lending-override", actionHint: "accept" }),
      ]),
    );
    expect(queue.recommendationCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "native-exact-pool", pool: "susde-native" }),
        expect.objectContaining({ kind: "source-family-adapter", project: "morpho-blue" }),
        expect.objectContaining({
          kind: "lending-allowlist",
          project: "new-lender",
          protocolCategory: "Lending",
          examplePools: ["new-usdc"],
          examplePoolDetails: [
            expect.objectContaining({
              pool: "new-usdc",
              sourceUrl: "https://yields.llama.fi/chart/new-usdc",
            }),
          ],
          sourceLinks: expect.arrayContaining([
            expect.objectContaining({
              label: "DeFiLlama protocols category source",
              url: "https://api.llama.fi/protocols",
            }),
            expect.objectContaining({ url: "https://yields.llama.fi/chart/new-usdc" }),
          ]),
          suggestedConfig: expect.objectContaining({
            anchor: "YIELD_ALLOWLIST_AUDIT_QUEUE_ANCHOR",
            snippet: '  "new-lender": { label: "New Lender" },',
          }),
          promotionMetadata: expect.objectContaining({
            sourceQueue: "monthly-unmatched-high-tvl",
            sourceQueueField: "unmatchedHighTvlPools",
            minPoolTvlUsd: 5_000_000,
            queueQualifiedPoolCount: 1,
            passedCategoryGate: true,
          }),
        }),
        expect.objectContaining({
          kind: "stale-venue-risk-score",
          id: "stale-venue-risk-score:aave-v3",
          title: "aave-v3",
          actionHint: "watch",
          project: "aave-v3",
        }),
        expect.objectContaining({
          kind: "venue-risk-config-missing",
          id: "venue-risk-config-missing:renamed-aave-v3",
          title: "renamed-aave-v3",
          actionHint: "accept",
          project: "renamed-aave-v3",
          protocolCategory: "Lending",
          examplePools: ["renamed-usdc"],
        }),
      ]),
    );
  });

  it("queues quarantine-ready-to-restore candidates as manual accept actions", () => {
    const queue = buildCoverageAuditOperatorQueue({
      gaps: {
        unmatchedHighTvlPools: [],
        missingProtocols: [],
        protocolRecommendations: [],
        nativeExactPoolRecommendations: [],
        sourceFamilyAdapterRecommendations: [],
        lendingAllowlistRecommendations: [],
        venueRiskConfigMissing: [],
      },
      manifestMissingIds: [],
      yieldBearingMissingFromRankings: [],
      quarantineReadyToRestore: [{
        stablecoinId: "reusd-re-protocol",
        code: "convert-to-assets-empty",
        since: "2026-03-15",
        nextReviewAt: "2026-08-09",
        sourceKey: "onchain:reusd-re-protocol",
        chain: "ethereum",
        contract: "0x1202f5c7B4b9E47a1A9837B26881B7C20112BD51",
        exchangeRate: 1.5,
      }],
    });

    expect(queue.recommendationCandidates).toContainEqual(
      expect.objectContaining({
        id: "quarantine-ready-to-restore:reusd-re-protocol",
        kind: "quarantine-ready-to-restore",
        title: "reusd-re-protocol",
        detail: "ethereum onchain:reusd-re-protocol probe returned 1.5",
        actionHint: "accept",
        stablecoinIds: ["reusd-re-protocol"],
      }),
    );
  });
});

describe("probeQuarantinedDeterministicAdapters", () => {
  const quarantinedAdapters = [
    {
      stablecoinId: "reusd-re-protocol",
      code: "convert-to-assets-empty",
      since: "2026-03-15",
      nextReviewAt: "2026-08-09",
    },
    {
      stablecoinId: "scrvusd-curve",
      code: "wrapper-not-yet-supported",
      since: "2026-04-11",
      nextReviewAt: "2026-10-09",
    },
  ];
  it("does not probe retired deterministic adapters", async () => {
    const result = await probeQuarantinedDeterministicAdapters({
      quarantinedAdapters,
      chainRpcs: new Map(),
    });

    expect(result.readyToRestore).toEqual([]);
    expect(result.summary).toEqual({
      configuredProbeCount: 0,
      attemptedCount: 0,
      readyToRestoreCount: 0,
      skippedCount: 0,
      failureCounts: {},
    });
    expect(mockFetchEvmUint256AtBlock).not.toHaveBeenCalled();
  });
});

describe("summarizeAdapterLifecycle", () => {
  const syntheticRegistry: Record<string, YieldAdapterLifecycleEntry> = {
    "alpha-active": { lifecycle: "active" },
    "beta-quarantined": {
      lifecycle: "quarantined",
      reason: {
        code: "convert-to-assets-empty",
        since: "2026-04-01",
        nextReviewAt: "2026-05-01",
        note: "needs protocol-specific reader",
      },
    },
    "gamma-gap": {
      lifecycle: "intentional-gap",
      reason: {
        code: "no-public-yield-source",
        since: "2026-03-10",
        note: "issuer publishes no APY oracle",
      },
    },
    "delta-experimental": {
      lifecycle: "experimental",
      reason: { code: "exploratory", since: "2026-05-15" },
    },
  };

  it("counts lifecycle states matching the synthetic registry", () => {
    const buckets = summarizeAdapterLifecycle(
      ["alpha-active", "beta-quarantined", "gamma-gap", "delta-experimental", "epsilon-unknown"],
      syntheticRegistry,
    );

    expect(buckets.lifecycleSummary).toEqual({
      active: 2, // alpha + epsilon (unknown defaults to active)
      quarantined: 1,
      intentionalGap: 1,
      experimental: 1,
    });
  });

  it("surfaces quarantined adapters with their structured reason", () => {
    const buckets = summarizeAdapterLifecycle(
      ["alpha-active", "beta-quarantined"],
      syntheticRegistry,
    );

    expect(buckets.quarantinedAdapters).toContainEqual({
      stablecoinId: "beta-quarantined",
      code: "convert-to-assets-empty",
      since: "2026-04-01",
      nextReviewAt: "2026-05-01",
      note: "needs protocol-specific reader",
    });
  });

  it("surfaces intentional gaps in their own bucket", () => {
    const buckets = summarizeAdapterLifecycle(["gamma-gap"], syntheticRegistry);

    expect(buckets.intentionalGaps).toContainEqual({
      stablecoinId: "gamma-gap",
      code: "no-public-yield-source",
      since: "2026-03-10",
      nextReviewAt: undefined,
      note: "issuer publishes no APY oracle",
    });
    expect(buckets.quarantinedAdapters).toEqual([]);
  });

  it("treats legacy/untyped IDs as active and leaves them out of buckets", () => {
    const buckets = summarizeAdapterLifecycle(
      ["only-legacy-id"],
      {}, // empty registry: every ID falls through to the default
    );

    expect(buckets.lifecycleSummary).toEqual({
      active: 1,
      quarantined: 0,
      intentionalGap: 0,
      experimental: 0,
    });
    expect(buckets.quarantinedAdapters).toEqual([]);
    expect(buckets.intentionalGaps).toEqual([]);
  });
});
