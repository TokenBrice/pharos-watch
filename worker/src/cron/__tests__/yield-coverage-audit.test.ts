import { afterEach, describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";

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

import { getCache, setCache } from "../../lib/db-cache";
import { computeSafetyScoresSnapshot } from "../../lib/safety-scores";
import type { CronProgressUpdate } from "../../lib/cron-logger";
import {
  buildCoverageAuditOperatorQueue,
  identifyCoverageGaps,
  identifyDeadCuratedPins,
  identifyStaleAutoLendingOverrides,
  isHighConfidenceProtocolCategory,
} from "../yield-coverage-audit/detectors";
import {
  runYieldCoverageAudit,
  summarizeAdapterLifecycle,
} from "../yield-coverage-audit";
import {
  YIELD_POOL_MAP,
  YIELD_VARIANT_MAP,
  YIELD_WEIGHTED_POOL_GROUPS,
} from "../../lib/yield-config/yield-config";
import { loadDlStablecoinPools } from "../yield-sync/sources";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import type { YieldAdapterLifecycleEntry } from "../../lib/yield-config/yield-config-registry";
import type { DlPool } from "../yield-sync/types";
import { buildYieldCoverageEvidenceFingerprint } from "../yield-coverage-review-dispositions";
import { makeDlYieldPool } from "./yield-resolve.test-support";
import { makeWorkerReportCardsV9Response } from "../../test-helpers/report-cards-v9";
import type { PublishedSafetyScoresResultMap } from "../../lib/safety-scores";
import { findStaleVenueRiskScores, type StaleVenueRiskScore } from "@shared/lib/yield-source-risk-registry";

const mockLoadDlStablecoinPools = vi.mocked(loadDlStablecoinPools);
const mockGetCache = vi.mocked(getCache);
const mockSetCache = vi.mocked(setCache);
const mockComputeSafetyScoresSnapshot = vi.mocked(computeSafetyScoresSnapshot);

function successfulSafetySnapshot(): PublishedSafetyScoresResultMap {
  const { safetyScoreIdentity } = makeWorkerReportCardsV9Response();
  return {
    kind: "ok",
    mode: "map",
    coveredCount: 1,
    trackedCount: 1,
    coverageRatio: 1,
    scores: new Map([["dllr-sovryn", { score: 49, grade: "D" }]]),
    source: "safety-score-v9-publication",
    safetyScoreIdentity,
    publicationGenerationId: safetyScoreIdentity.publicationGenerationId,
    methodologyVersion: safetyScoreIdentity.methodologyVersion,
    publishedAt: Math.floor(Date.now() / 1000),
  };
}

// A live lending pool: the coverage gates key off a flat, non-null APY triple, so
// every candidate fixture carries the same 4% base unless a case varies it.
function lendingPool(overrides: Partial<DlPool> & { pool: string; project: string }): DlPool {
  return makeDlYieldPool({ apy: 4, apyBase: 4, apyMean30d: 4, ...overrides });
}

function protocolBasket(project: string, thirdSymbol: string, thirdTvlUsd: number, firstPool = 1): DlPool[] {
  return [
    lendingPool({ pool: `p${firstPool}`, project, symbol: "USDC", tvlUsd: 4_000_000 }),
    lendingPool({ pool: `p${firstPool + 1}`, project, symbol: "USDT", tvlUsd: 4_000_000, apy: 3.5, apyBase: 3.5, apyMean30d: 3.5 }),
    makeDlYieldPool({ pool: `p${firstPool + 2}`, project, chain: "Arbitrum", symbol: thirdSymbol, tvlUsd: thirdTvlUsd }),
  ];
}

afterEach(() => {
  mockLoadDlStablecoinPools.mockReset();
  mockGetCache.mockReset();
  mockSetCache.mockReset();
  mockComputeSafetyScoresSnapshot.mockReset();
  vi.useRealTimers();
});

function inferExpectedProtocolLabel(project: string): string {
  return project
    .split(/[-_.]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

describe("buildProtocolCategoryLookupFromCachePayload", () => {
  it("accepts the allowed lending categories for high-confidence recommendations", () => {
    expect(isHighConfidenceProtocolCategory("Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("CDP")).toBe(true);
    expect(isHighConfidenceProtocolCategory("RWA Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("Uncollateralized Lending")).toBe(true);
    expect(isHighConfidenceProtocolCategory("Yield Aggregator")).toBe(false);
    expect(isHighConfidenceProtocolCategory(null)).toBe(false);
  });
});

describe("coverage detector pre-cap cohorts", () => {
  it("keeps all 25 lending and venue candidates until durable review and publication", async () => {
    const projects = Array.from({ length: 25 }, (_, i) => `uncurated-lender-${i}`);
    const pools = projects.map((project, i) => lendingPool({ pool: `uncurated-pool-${i}`,
      project, symbol: "USDC", tvlUsd: 10_000_000 }));
    const publishedRows = projects.map((project, i) => ({
      stablecoinId: `coin-${i}`, venueProtocol: `unreviewed-${project}`, sourceKey: `protocol-api:${project}`,
      sourceTvlUsd: 10_000_000,
    }));
    const gaps = identifyCoverageGaps(pools, new Set(), undefined,
      new Map(projects.map((project) => [project, "Lending"])), { publishedVenueRows: publishedRows });
    expect(gaps.lendingAllowlistRecommendations).toHaveLength(25);
    expect(gaps.venueRiskConfigMissing).toHaveLength(25);
    const candidates = buildCoverageAuditOperatorQueue({ gaps, manifestMissingIds: [],
      yieldBearingMissingFromRankings: [], staleVenueRiskScores: [] });
    expect(candidates.recommendationCandidates.filter((item) => item.kind === "lending-allowlist")).toHaveLength(25);
    expect(candidates.recommendationCandidates.filter((item) => item.kind === "venue-risk-config-missing")).toHaveLength(25);

    mockLoadDlStablecoinPools.mockResolvedValue({ pools,
      meta: { mode: "dex-cache", updatedAt: 1_774_526_300, ageSeconds: 100, poolCount: pools.length, fallbackMode: null } });
    mockGetCache.mockImplementation(async (_db, key) => {
      if (key === "stablecoins") return { value: "[]", updatedAt: 1_774_526_300 };
      if (key === "yield-rankings") return { value: JSON.stringify({ rankings: publishedRows.map((row) => ({
        id: row.stablecoinId, sourceTvlUsd: row.sourceTvlUsd,
        sourceRisk: { venueProtocol: row.venueProtocol }, provenance: { sourceKey: row.sourceKey },
      })) }), updatedAt: 1_774_526_300 };
      if (key === "defillama-protocols") return { value: JSON.stringify({ protocols:
        projects.map((slug) => ({ slug, category: "Lending" })) }), updatedAt: 1_774_526_300 };
      return null;
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue(successfulSafetySnapshot());
    const db = mockD1([{ match: "yield_coverage_review_dispositions", rows: [] }]);
    await runYieldCoverageAudit(db);
    const report = JSON.parse(String(mockSetCache.mock.calls[0]?.[2]));
    expect(report.lendingAllowlistRecommendationCount).toBe(25);
    expect(report.venueRiskConfigMissingCount).toBe(25);
    expect(report.lendingAllowlistRecommendations).toHaveLength(20);
    expect(report.venueRiskConfigMissing).toHaveLength(20);
    expect(report.queueTotals.totalItemCount).toBe(report.queueTotals.publishedItemCount + report.queueTotals.truncatedItemCount);
    expect(report.queueTotals.byKind["lending-allowlist"]).toBe(25);
    expect(report.queueTotals.byKind["venue-risk-config-missing"]).toBe(25);
    const dispositionReads = db.getHistory().filter((entry) => entry.sql.includes("yield_coverage_review_dispositions"));
    const allReadIds = dispositionReads.flatMap((entry) => entry.binds);
    for (const candidate of candidates.recommendationCandidates) expect(allReadIds).toContain(candidate.id);
    const suppressed = candidates.recommendationCandidates.find((item) => item.kind === "lending-allowlist")!;
    const nowSec = Math.floor(Date.now() / 1000);
    const reviewedDb = mockD1([{ match: "yield_coverage_review_dispositions", rows: [{
      queue_item_id: suppressed.id, queue_item_kind: suppressed.kind,
      evidence_fingerprint: buildYieldCoverageEvidenceFingerprint(suppressed), disposition: "watch",
      evidence: "Reviewed matching source evidence", review_owner: "yield-review",
      reviewed_at: nowSec - 60, next_review_at: nowSec + 3600, expires_at: nowSec + 7200,
    }] }]);
    await runYieldCoverageAudit(reviewedDb);
    const reviewWrites = mockSetCache.mock.calls.filter((call) => call[1] === "yield-coverage-audit");
    const reviewed = JSON.parse(String(reviewWrites[reviewWrites.length - 1]?.[2]));
    expect(reviewed.queueTotals.suppressedItemCount).toBe(1);
    expect(reviewed.queueTotals.byKind["lending-allowlist"]).toBe(24);
    expect(reviewed.queueTotals.totalItemCount).toBe(report.queueTotals.totalItemCount - 1);
    expect(reviewed.queueTotals.totalItemCount).toBe(reviewed.queueTotals.publishedItemCount + reviewed.queueTotals.truncatedItemCount);
  });
});

describe("runYieldCoverageAudit", () => {
  it.each([
    ["missing", null],
    ["malformed", "{"],
    ["malformed", JSON.stringify({ unexpected: [] })],
  ])("defers without publishing falsely clean supply evidence for %s cache", async (state, value) => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [lendingPool({ pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000 })],
      meta: { mode: "dex-cache", updatedAt: 1_774_526_300, ageSeconds: 100, poolCount: 1, fallbackMode: null },
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue(successfulSafetySnapshot());
    mockGetCache.mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") return { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 };
      if (key === "stablecoins" && value != null) return { value, updatedAt: 1_774_526_300 };
      return null;
    });
    const result = await runYieldCoverageAudit(mockD1());
    expect(result.status).toBe("degraded");
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: `stablecoins-cache-${state}`,
      stablecoinSupplyMapState: state,
    });
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it("defers when the compact safety snapshot is not complete and never requests computed V8 scores", async () => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [lendingPool({ pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000 })],
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
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    } as never);
    mockGetCache.mockImplementation(async (_db, key) =>
      key === "yield-rankings"
        ? { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 }
        : null
    );

    const result = await runYieldCoverageAudit(mockD1());

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "safety-snapshot-unavailable:safety-score-v9-publication:completeness-mismatch",
    });
    expect(mockComputeSafetyScoresSnapshot).toHaveBeenCalledOnce();
    expect(mockComputeSafetyScoresSnapshot).toHaveBeenCalledWith(expect.anything());
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    "{}",
    JSON.stringify({ rankings: null }),
    JSON.stringify({ rankings: {} }),
    JSON.stringify({ rankings: [null] }),
    JSON.stringify({ rankings: [{ id: 42 }] }),
    JSON.stringify({ rankings: [{ id: "coin", sourceTvlUsd: "unknown" }] }),
    JSON.stringify({ rankings: [{ id: "coin", altSources: {} }] }),
    JSON.stringify({ rankings: [{ id: "coin", altSources: [null] }] }),
    JSON.stringify({ rankings: [{ id: "coin", altSources: [{}] }] }),
    JSON.stringify({ rankings: [{ id: "coin", altSources: [{ sourceKey: "alternate", sourceRisk: { venueProtocol: 42 } }] }] }),
    JSON.stringify({ rankings: [{ id: "coin", provenance: { sourceKey: 42 } }] }),
  ])("defers without report or durable candidate writes for malformed rankings: %s", async (value) => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [lendingPool({ pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000 })],
      meta: { mode: "dex-cache", updatedAt: 1_774_526_300, ageSeconds: 100, poolCount: 1, fallbackMode: null },
    });
    mockGetCache.mockImplementation(async (_db, key) =>
      key === "yield-rankings"
        ? { value, updatedAt: 1_774_526_300 }
        : null
    );

    const db = mockD1();
    const result = await runYieldCoverageAudit(db);

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "yield-rankings-cache-malformed",
    });
    expect(mockComputeSafetyScoresSnapshot).not.toHaveBeenCalled();
    expect(mockSetCache).not.toHaveBeenCalled();
    expect(db.getHistory()).toEqual([]);
  });

  it("treats a validated empty rankings array as available coverage", async () => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [lendingPool({ pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000 })],
      meta: { mode: "dex-cache", updatedAt: 1_774_526_300, ageSeconds: 100, poolCount: 1, fallbackMode: null },
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue(successfulSafetySnapshot());
    mockGetCache.mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") return { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 };
      if (key === "stablecoins") return { value: "[]", updatedAt: 1_774_526_300 };
      if (key === "defillama-protocols") {
        return { value: JSON.stringify({ protocols: [] }), updatedAt: 1_774_526_300 };
      }
      return null;
    });
    const result = await runYieldCoverageAudit(mockD1([{ match: "yield_coverage_review_dispositions", rows: [] }]));
    expect(result.status).toBe("ok");
    expect(mockSetCache).toHaveBeenCalledWith(expect.anything(), "yield-coverage-audit", expect.any(String));
  });

  it.each([
    ["active V9 marker", "active-safety-score:v9"],
    ["malformed V9 marker", "active-safety-score:activation-marker-invalid"],
    ["mismatched V9 identity", "active-safety-score:v9-identity-mismatch"],
  ])("defers with explicit V9 provenance for %s", async (_label, reason) => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [lendingPool({ pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000 })],
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
      safetyScoreIdentity: null,
      publicationGenerationId: null,
      methodologyVersion: null,
      publishedAt: null,
    } as never);
    mockGetCache.mockImplementation(async (_db, key) =>
      key === "yield-rankings"
        ? { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 }
        : null
    );

    const result = await runYieldCoverageAudit(mockD1());

    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: `safety-snapshot-unavailable:${reason}`,
      safetyScoreIdentity: null,
    });
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it("reports bounded progress stages through cache publication", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-21T00:00:00Z"));
    const dlPools: DlPool[] = [lendingPool({
      pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000,
    })];
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
      if (key === "stablecoins") return { value: "[]", updatedAt: 1_774_526_300 };
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
    mockComputeSafetyScoresSnapshot.mockResolvedValue(successfulSafetySnapshot());

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
    const result = await runYieldCoverageAudit(db, undefined, async (update) => {
      progressUpdates.push(update);
    });

    expect(result.status).toBe("ok");
    expect(mockSetCache).toHaveBeenCalledWith(
      db,
      "yield-coverage-audit",
      expect.stringContaining('"reportedAt"'),
    );
    const cachedReport = JSON.parse(String(mockSetCache.mock.calls[0]?.[2])) as {
      staleVenueRiskScoreCount: number;
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
        "cache-write",
        "complete",
      ]),
    );
    expect(progressUpdates.every((update) => update.itemsTotal === 5)).toBe(true);
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
    expect(mockComputeSafetyScoresSnapshot).toHaveBeenCalledWith(db);
    expect(progressUpdates.some((update) => update.stage === "quarantine-probe")).toBe(false);
    expect(progressUpdates[progressUpdates.length - 1]).toMatchObject({
      stage: "complete",
      itemsDone: 5,
      metadata: {
        cacheKey: "yield-coverage-audit",
      },
    });
  });

  it("returns degraded when protocol-category cache is unavailable", async () => {
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: [lendingPool({ pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000 })],
      meta: {
        mode: "dex-cache",
        updatedAt: 1_774_526_300,
        ageSeconds: 100,
        poolCount: 1,
        fallbackMode: null,
      },
    });
    mockGetCache.mockImplementation(async (_db, key) => {
      if (key === "stablecoins") return { value: "[]", updatedAt: 1_774_526_300 };
      if (key === "yield-rankings") {
        return { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 };
      }
      return null;
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue(successfulSafetySnapshot());

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

  it("publishes queue totals that account for every candidate item", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-09-27T00:00:00Z"));
    const dlPools: DlPool[] = [
      lendingPool({ pool: "new-usdc", project: "new-lender", symbol: "USDC", tvlUsd: 12_000_000 }),
      makeDlYieldPool({
        pool: "dex-usdt",
        project: "new-dex",
        symbol: "USDT",
        tvlUsd: 30_000_000,
        apy: 3,
        apyBase: 3,
        apyMean30d: 3,
      }),
    ];
    mockLoadDlStablecoinPools.mockResolvedValue({
      pools: dlPools,
      meta: { mode: "dex-cache", updatedAt: 1_774_526_300, ageSeconds: 100, poolCount: 2, fallbackMode: null },
    });
    mockGetCache.mockImplementation(async (_db, key) => {
      if (key === "stablecoins") return { value: "[]", updatedAt: 1_774_526_300 };
      if (key === "defillama-protocols") {
        return {
          value: JSON.stringify({
            protocols: [
              { slug: "new-lender", category: "Lending" },
              { slug: "new-dex", category: "Dexs" },
            ],
          }),
          updatedAt: 1_774_526_300,
        };
      }
      if (key === "yield-rankings") {
        return { value: JSON.stringify({ rankings: [] }), updatedAt: 1_774_526_300 };
      }
      return null;
    });
    mockComputeSafetyScoresSnapshot.mockResolvedValue(successfulSafetySnapshot());

    const result = await runYieldCoverageAudit(mockD1([{
      match: "yield_coverage_review_dispositions",
      rows: [],
    }]));

    expect(result.status).toBe("ok");
    const report = JSON.parse(String(mockSetCache.mock.calls[0]?.[2])) as {
      queueTotals: { byKind: Record<string, number>; byKindScope: string; totalItemCount: number; publishedItemCount: number; truncatedItemCount: number; suppressedItemCount: number; truncated: boolean };
      operatorQueue: {
        allowedActions: string[];
        headlineGaps: Array<{ kind: string }>;
        recommendationCandidates: Array<{ kind: string }>;
      };
      operatorReviewSummary: { candidateItemCount: number; truncatedItemCount: number };
      deadCuratedPinCount: number;
      lifecycleReviewDueCount: number;
      reviewDueAdapters: unknown[];
      staleVenueRiskScores: StaleVenueRiskScore[];
    };
    const publishedItems = [
      ...report.operatorQueue.headlineGaps,
      ...report.operatorQueue.recommendationCandidates,
    ];
    expect(report.queueTotals.byKindScope).toBe("full-visible");
    expect(Object.values(report.queueTotals.byKind).reduce((total, count) => total + count, 0))
      .toBe(report.queueTotals.totalItemCount);
    expect(report.queueTotals.publishedItemCount).toBe(publishedItems.length);
    expect(report.queueTotals.totalItemCount).toBe(report.queueTotals.publishedItemCount + report.queueTotals.truncatedItemCount);
    // Publication caps each class at 20 items, and this snapshot leaves every
    // curated pin and ranking row uncovered, so the queue must report truncation.
    expect(report.queueTotals.truncated).toBe(true);
    expect(report.operatorReviewSummary.candidateItemCount).toBe(
      publishedItems.length
      + report.operatorReviewSummary.truncatedItemCount
      + report.queueTotals.suppressedItemCount,
    );
    expect(report.operatorQueue.allowedActions).toEqual(["accept", "dismiss", "intentional-gap", "watch"]);
    expect(report.deadCuratedPinCount).toBeGreaterThanOrEqual(Object.keys(YIELD_POOL_MAP).length);
    expect(report.lifecycleReviewDueCount).toBe(report.reviewDueAdapters.length);
    const staleVenues = findStaleVenueRiskScores(Date.now());
    expect(staleVenues.length).toBeGreaterThan(20);
    expect(report.staleVenueRiskScores).toEqual(staleVenues);
  });
});

describe("identifyCoverageGaps", () => {
  it("identifies high-TVL stablecoin pools not matched", () => {
    const dlPools: DlPool[] = [makeDlYieldPool({
      pool: "unknown-pool",
      project: "new-protocol",
      symbol: "NEW_STABLE",
      tvlUsd: 50_000_000,
    })];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.unmatchedHighTvlPools.length).toBe(1);
    expect(gaps.unmatchedHighTvlPools[0].pool).toBe("unknown-pool");
  });

  it("drops sub-threshold pools from the protocol bucket", () => {
    const dlPools: DlPool[] = [lendingPool({ pool: "dust-usdc", project: "dust-dex", symbol: "USDC", tvlUsd: 900_000 })];

    const gaps = identifyCoverageGaps(dlPools, new Set(), undefined, new Map([["dust-dex", "Dexs"]]));

    expect(gaps.missingProtocols).toEqual([]);
    expect(gaps.unmatchedHighTvlPools).toEqual([]);
  });

  it("queues unknown-venue published rows above the high-TVL floor", () => {
    const gaps = identifyCoverageGaps([], new Set(), undefined, new Map(), {
      publishedVenueRows: [
        {
          stablecoinId: "mega-coin",
          venueProtocol: "unreviewed-mega-venue",
          sourceKey: "defillama:mega",
          sourceTvlUsd: 2_560_000_000,
        },
        {
          stablecoinId: "mega-sibling",
          venueProtocol: "Unreviewed-Mega-Venue",
          sourceKey: "defillama:mega-sibling",
          sourceTvlUsd: 40_000_000,
        },
        {
          stablecoinId: "small-coin",
          venueProtocol: "unreviewed-small-venue",
          sourceKey: null,
          sourceTvlUsd: 1_000_000,
        },
        {
          stablecoinId: "reviewed-coin",
          venueProtocol: "aave-v3",
          sourceKey: null,
          sourceTvlUsd: 900_000_000,
        },
        {
          stablecoinId: "routed-coin",
          venueProtocol: null,
          sourceKey: "protocol-api:kong:ethereum:0xabc",
          sourceTvlUsd: 25_000_000,
        },
      ],
    });

    expect(gaps.venueRiskConfigMissing.map((candidate) => candidate.project))
      .toEqual(["unreviewed-mega-venue", "kong"]);
    expect(gaps.venueRiskConfigMissing[0]).toMatchObject({
      poolCount: 2,
      totalTvlUsd: 2_600_000_000,
      stablecoinIds: ["mega-coin", "mega-sibling"],
      sourceKeys: ["defillama:mega", "defillama:mega-sibling"],
    });

    const queue = buildCoverageAuditOperatorQueue({
      gaps,
      manifestMissingIds: [],
      yieldBearingMissingFromRankings: [],
      staleVenueRiskScores: [],
    });
    expect(queue.recommendationCandidates).toContainEqual(
      expect.objectContaining({
        id: "venue-risk-config-missing:unreviewed-mega-venue",
        kind: "venue-risk-config-missing",
        stablecoinIds: ["mega-coin", "mega-sibling"],
      }),
    );
  });

  it("recommends high-confidence protocols with >$10M TVL and 3+ pools", () => {
    const dlPools = protocolBasket("rising-protocol", "USDC", 3_000_000);
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

  it("requires an allowed lending category before assigning high-confidence", () => {
    const dlPools = [
      ...protocolBasket("aggregator-protocol", "DAI", 4_000_000),
      ...protocolBasket("missing-category-protocol", "DAI", 4_000_000, 4),
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

  it("escapes provider slugs in suggested lending allowlist snippets", () => {
    const maliciousProject = 'evil"\n  __pwned__: (() => { throw new Error("injected"); })(),\n  "tail';
    const dlPools: DlPool[] = [
      lendingPool({ pool: "evil-usdc", project: maliciousProject, symbol: "USDC", tvlUsd: 12_000_000 }),
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

  it("marks review-needed for protocols with <$10M TVL or <3 pools", () => {
    const dlPools: DlPool[] = [
      makeDlYieldPool({
        pool: "p1",
        project: "small-protocol",
        symbol: "USDC",
        tvlUsd: 6_000_000,
        apy: 3,
        apyBase: 3,
        apyMean30d: 3,
      }),
    ];
    const gaps = identifyCoverageGaps(dlPools, new Set());
    expect(gaps.protocolRecommendations).toContainEqual(
      expect.objectContaining({
        project: "small-protocol",
        recommendedTier: "review-needed",
      }),
    );
  });

  it.each([
    {
      name: "flags deterministic auto-lending overrides that no longer pass static venue gates",
      pools: [makeDlYieldPool({
        pool: "be50b874-8147-440d-b8ca-f2c202e9ed64",
        chain: "Flare",
        project: "clearpool-lending",
        symbol: "USDX",
        tvlUsd: 1,
        apy: 0.01,
        apyBase: 0.01,
        apyMean30d: 0.01,
        underlyingTokens: ["0x4a771cc1a39fdd8aa08b8ea51f7fd412e73b3d2b"],
      })],
      options: { stablecoinSupplyById: new Map([["usdx-hex-trust", 1_000_000]]) },
      expected: {
        stablecoinId: "usdx-hex-trust",
        pool: "be50b874-8147-440d-b8ca-f2c202e9ed64",
        reasons: expect.arrayContaining(["below-apy-floor", "below-tvl-floor"]),
      },
    },
    {
      name: "applies the same supply-relative TVL floor as hourly auto-lending publication",
      pools: [makeDlYieldPool({
        pool: "be50b874-8147-440d-b8ca-f2c202e9ed64",
        chain: "Flare",
        project: "clearpool-lending",
        symbol: "USDX",
        tvlUsd: 500_000,
        underlyingTokens: ["0x4a771cc1a39fdd8aa08b8ea51f7fd412e73b3d2b"],
      })],
      options: { stablecoinSupplyById: new Map([["usdx-hex-trust", 1_000_000_000]]) },
      expected: {
        stablecoinId: "usdx-hex-trust",
        requiredMinTvlUsd: 1_000_000,
        reasons: expect.arrayContaining(["below-tvl-floor"]),
      },
    },
    {
      name: "flags deterministic auto-lending overrides that no longer pass the safety gate",
      pools: [makeDlYieldPool({
        pool: "d3b28212-a46b-4db8-8bb7-2c946b3cbe76",
        project: "morpho-blue",
        symbol: "STEAKEURCV",
        tvlUsd: 2_000_000,
      })],
      options: {
        stablecoinSupplyById: new Map([["eurcv-societe-generale-forge", 1_000_000]]),
        safetyScores: new Map([["eurcv-societe-generale-forge", { score: 49 }]]),
      },
      expected: {
        stablecoinId: "eurcv-societe-generale-forge",
        reasons: expect.arrayContaining(["below-safety-score"]),
      },
    },
  ])("$name", ({ pools, options, expected }) => {
    const stale = identifyStaleAutoLendingOverrides(pools, options);
    expect(stale).toContainEqual(expect.objectContaining(expected));
  });
});

describe("identifyDeadCuratedPins", () => {
  it("emits a missing-pool item for every curated pin when the snapshot is empty", () => {
    const pins = identifyDeadCuratedPins([]);

    expect(pins.filter((pin) => pin.registry === "native-pool").map((pin) => pin.stablecoinId).sort())
      .toEqual(Object.keys(YIELD_POOL_MAP).sort());
    expect(pins.filter((pin) => pin.registry === "variant-pool").map((pin) => pin.stablecoinId).sort())
      .toEqual(Object.keys(YIELD_VARIANT_MAP).sort());
    expect(pins.filter((pin) => pin.registry === "weighted-pool-group").map((pin) => pin.stablecoinId).sort())
      .toEqual(Object.keys(YIELD_WEIGHTED_POOL_GROUPS).sort());
    expect([...new Set(pins.map((pin) => pin.reasons.join(",")))]).toEqual(["missing-pool"]);
    // Without published ranking ids the audit cannot classify coverage.
    expect([...new Set(pins.map((pin) => pin.coverage))]).toEqual([null]);
  });

  it("separates a dead config from a coverage outage and clears resolved pins", () => {
    const pins = identifyDeadCuratedPins(
      [makeDlYieldPool({ pool: YIELD_POOL_MAP["susde-ethena"], project: "ethena", symbol: "sUSDe" })],
      { publishedStablecoinIds: new Set(["usdn-smardex"]) },
    );

    expect(pins.find((pin) => pin.registry === "native-pool" && pin.stablecoinId === "susde-ethena"))
      .toBeUndefined();
    expect(pins.find((pin) => pin.registry === "native-pool" && pin.stablecoinId === "usdn-smardex"))
      .toMatchObject({
        pin: YIELD_POOL_MAP["usdn-smardex"],
        missingPoolIds: [YIELD_POOL_MAP["usdn-smardex"]],
        reasons: ["missing-pool"],
        coverage: "dead-config",
      });
    expect(pins.find((pin) => pin.registry === "native-pool" && pin.stablecoinId === "ousd-origin-protocol"))
      .toMatchObject({ coverage: "coverage-outage" });
  });

  it("reports the absent legs of a weighted pool group and the ones still present", () => {
    const [stablecoinId, group] = Object.entries(YIELD_WEIGHTED_POOL_GROUPS)[0];
    const pins = identifyDeadCuratedPins(
      [makeDlYieldPool({
        pool: group.poolIds[0],
        project: group.expectedProject,
        symbol: group.expectedSymbol,
      })],
      { publishedStablecoinIds: new Set() },
    );

    expect(pins.find((pin) => pin.registry === "weighted-pool-group" && pin.stablecoinId === stablecoinId))
      .toMatchObject({
        missingPoolIds: group.poolIds.slice(1),
        presentPoolIds: [group.poolIds[0]],
        reasons: ["missing-pool"],
        coverage: "coverage-outage",
      });
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

  it("flags a lifecycle review whose registry date has arrived", () => {
    const buckets = summarizeAdapterLifecycle(
      ["alpha-active", "beta-quarantined", "gamma-gap", "delta-experimental"],
      syntheticRegistry,
      Date.parse("2026-05-01T00:00:00Z"),
    );

    expect(buckets.reviewDueAdapters.map((adapter) => adapter.stablecoinId)).toEqual(["beta-quarantined"]);
  });

  it("does not flag a lifecycle review before its registry date or without one", () => {
    const buckets = summarizeAdapterLifecycle(
      ["beta-quarantined", "gamma-gap"],
      syntheticRegistry,
      Date.parse("2026-04-30T23:59:59Z"),
    );

    expect(buckets.reviewDueAdapters).toEqual([]);
  });
});
