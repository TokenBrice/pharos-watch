import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import {
  mutableActiveStablecoins,
  makeStablecoinsCacheValue,
  makeDb,
  getPublishedYieldRows,
  findPublishedYieldRow,
  findPublishedYieldHistoryRow,
  getYieldRankingsCachePayload,
  mockHealthyRiskFreeRateCache,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
  mockD1WithYieldPruneTables,
  yieldFallbackTableMatches,
  testSafetyScoreIdentity,
  testSafetyScoresSnapshot,
} from "./sync-yield-data.test-support";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { ACTIVE_STABLECOINS, FROZEN_IDS } from "@shared/lib/stablecoins/registry";
import { syncYieldData } from "../yield-sync/sync-yield-data";
import * as yieldHelpersModule from "../yield-sync/yield-helpers";
import * as publicationModule from "../yield-sync/publication-generation";
import { batchExecute } from "../../lib/db";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import * as safetyScoreActiveSourceModule from "../../lib/safety-score-v9/safety-score-active-source";
import * as safetyScoresModule from "../../lib/safety-score-v9/safety-scores";
import * as yieldPools from "../../lib/yield-config/yield-config-pools";
import { cacheRow, dlPoolsCacheRow, installYieldCacheReader } from "./yield-cache.test-support";
import { makeDlYieldPool } from "./yield-resolve.test-support";
import type * as YieldHelpers from "../yield-sync/yield-helpers";
import type { YieldRankingsResponse } from "@shared/types/yield";

function makePublicationCacheDb() {
  return mockD1WithYieldPruneTables(yieldFallbackTableMatches());
}

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); (FROZEN_IDS as Set<string>).delete("usr-resolv"); });
function pruneDb(rows: [string, string, number][]) {
  const fixture = fixtures.open();
  (FROZEN_IDS as Set<string>).add("usr-resolv");
  const insert = fixture.sqlite.prepare(`INSERT INTO yield_data
    (stablecoin_id, source_key, symbol, current_apy, apy_7d, apy_30d, yield_source, yield_type, data_source, updated_at)
    VALUES (?, ?, 'T', 5, 5, 5, 'T', 'lending-vault', 'defillama', ?)`);
  for (const row of rows) insert.run(...row);
  mockHealthyRiskFreeRateCache();
  mockFetch([{ match: "yields.llama.fi", body: { data: [
    makeDlYieldPool({ pool: "pool-sdai-1", tvlUsd: 1_000_000_000, apy: 5.2, apyBase: 5.2, apyMean30d: 5.1 }),
  ] } }]);
  return fixture;
}

describe("syncYieldData", () => {
  beforeEach(resetSyncYieldDataTest);
  afterEach(cleanupSyncYieldDataTest);
  it.each([false, true])("publishes current/held safety at the inclusive original-clock boundary without restamping (held=%s)", async (held) => {
    const db = makePublicationCacheDb();
    const now = Math.floor(Date.now() / 1000);
    const publishedAt = now - 86400;
    const snapshot = testSafetyScoresSnapshot({
      kind: held ? "degraded" : "ok", ...(held ? { reason: "v9-publication-held" } : {}),
      publishedAt, trackedCount: 1, scores: new Map([["100", { score: 80, grade: "B+" }]]),
    });
    vi.mocked(safetyScoresModule.computeSafetyScoresSnapshot).mockResolvedValue(snapshot);
    mockHealthyRiskFreeRateCache();
    mockFetch([{ match: "yields.llama.fi", body: { data: [
      makeDlYieldPool({ pool: "pool-sdai-1", project: "maker", symbol: "sDAI", tvlUsd: 1_000_000_000, apy: 5.2, apyBase: 5.2, apyMean30d: 5.1 }),
    ] } }]);

    const result = await syncYieldData(db);
    expect(result.status).toBe("ok");
    expect(getPublishedYieldRows(db).length).toBeGreaterThan(0);
    const payload = getYieldRankingsCachePayload(db) as YieldRankingsResponse;
    expect(payload.updatedAt).toBe(now);
    expect(payload.provenance?.safetySnapshot).toMatchObject({
      publishedAt, safetyScoreIdentity: snapshot.safetyScoreIdentity, kind: held ? "degraded" : "ok",
    });
  });

  it.each([86401, null, Number.NaN, Number.POSITIVE_INFINITY, -1])("defers current safety with an expired or invalid original clock (%s)", async (age) => {
    const db = makePublicationCacheDb();
    const now = Math.floor(Date.now() / 1000);
    const publishedAt = age === null ? null : now - age;
    const snapshot = testSafetyScoresSnapshot({ publishedAt, trackedCount: 1,
      scores: new Map([["100", { score: 80, grade: "B+" }]]) });
    vi.mocked(safetyScoresModule.computeSafetyScoresSnapshot).mockResolvedValue(snapshot);
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    expect(result.status).toBe("degraded");
    expect(result.productivity).toMatchObject({ productive: false, reason: "safety-snapshot-unavailable" });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      reason: "safety-snapshot-unavailable:safety-publication-clock-out-of-budget",
      safetyScoreIdentity: snapshot.safetyScoreIdentity, safetySnapshotHeld: false,
      safetyPublishedAt: publishedAt != null && Number.isFinite(publishedAt) ? publishedAt : null,
      acceptedPublicationAgeSeconds: age === 86401 ? 86401 : null,
    });
    expect(getPublishedYieldRows(db)).toHaveLength(0);
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
  });

  it("syncs yield data from DeFiLlama pools on normal path", async () => {
    const db = makePublicationCacheDb();

    // DL yields API returns a pool matching sDAI
    mockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            makeDlYieldPool({ pool: "pool-sdai-1", project: "maker", symbol: "sDAI", tvlUsd: 1_000_000_000, apy: 5.2, apyBase: 5.2, apyMean30d: 5.1 }),
          ],
        },
      },
    ]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    expect(getPublishedYieldRows(db)).toHaveLength(1);
    expect(getYieldRankingsCachePayload(db)).toBeDefined();
    expect((getYieldRankingsCachePayload(db) as YieldRankingsResponse).provenance?.safetySnapshot)
      .toMatchObject({ coveredCount: 4, trackedCount: 4, coverageRatio: 1 });
    const sentinel = db.getHistory().find((entry) => entry.binds[0] === "freshness:yield-data");
    expect(JSON.parse(String(sentinel?.binds[1]))).toMatchObject({
      generationId: (getYieldRankingsCachePayload(db) as YieldRankingsResponse).publication?.generationId,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  });

  it("loads stablecoin supply once and requests the published safety generation", async () => {
    const db = makePublicationCacheDb();
    const updatedAt = Math.floor(Date.now() / 1000);
    installYieldCacheReader(vi.mocked(getCache), {
      stablecoins: cacheRow(makeStablecoinsCacheValue(), updatedAt),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await syncYieldData(db);

    const stablecoinsReads = vi.mocked(getCache).mock.calls.filter((call) => call[1] === "stablecoins");
    const safetyCalls = vi.mocked(safetyScoresModule.computeSafetyScoresSnapshot).mock.calls;
    const safetyCall = safetyCalls[safetyCalls.length - 1];

    expect(stablecoinsReads).toHaveLength(1);
    // Both reads share the run's D1-cost-tracked binding.
    expect(safetyCall?.[0]).toBe(stablecoinsReads[0]?.[0]);
  });

  it("publishes coherent results when the safety identity changes before publish", async () => {
    const db = makePublicationCacheDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const safetySnapshot = vi.mocked(safetyScoresModule.computeSafetyScoresSnapshot);
    const currentSafetyIdentity = vi.mocked(
      safetyScoreActiveSourceModule.loadActiveSafetyScoreIdentity,
    );
    safetySnapshot.mockResolvedValueOnce(
      testSafetyScoresSnapshot({
        trackedCount: 4,
        publishedAt: nowSec,
        scores: new Map([
          ["100", { score: 80, grade: "B+" }],
          ["usdc-circle", { score: 78, grade: "B+" }],
          ["u-united-stables", { score: 55, grade: "C" }],
          ["lusd-liquity", { score: 86, grade: "A-" }],
        ]),
      }),
    );
    currentSafetyIdentity.mockResolvedValue({
      kind: "v9",
      safetyScoreIdentity: testSafetyScoreIdentity({
        policyDigest: "f".repeat(64),
        evaluationBuildDigest: "d".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
        publicationGenerationId: "report-cards:v9:new-build",
      }),
    });

    mockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            makeDlYieldPool({ pool: "pool-sdai-1", project: "maker", symbol: "sDAI", tvlUsd: 1_000_000_000, apy: 5.2, apyBase: 5.2, apyMean30d: 5.1 }),
          ],
        },
      },
    ]);

    const result = await syncYieldData(db);

    expect(safetySnapshot).toHaveBeenCalledTimes(1);
    expect(currentSafetyIdentity).toHaveBeenCalledTimes(1);
    // The run publishes its coherent results stamped with the identity it
    // loaded; the read path serves them as a publish-time snapshot until the
    // next run re-aligns. Withholding the publish would only pin an older,
    // equally mismatched cache.
    expect(result.itemCount).toBeGreaterThan(0);
    expect(result.productivity).toMatchObject({
      productive: true,
      publications: [{ surface: "yield-rankings", generationId: expect.any(String), artifactCacheKey: "yield-rankings" }],
    });
    expect(result.metadata).toContain("yield-safety-identity-changed-before-publish");
    expect(getPublishedYieldRows(db).length).toBeGreaterThan(0);
    const cachePayload = getYieldRankingsCachePayload(db) as {
      publication?: { generationId?: string };
      provenance?: { safetySnapshot?: { safetyScoreIdentity?: { evaluationBuildDigest?: string } } };
    } | undefined;
    expect(cachePayload?.provenance?.safetySnapshot?.safetyScoreIdentity?.evaluationBuildDigest).toBe("b".repeat(64));
    expect(result.productivity?.publications).toHaveLength(1);
    expect(result.productivity?.publications?.[0].generationId).toBe(cachePayload?.publication?.generationId);
    expect(db.getHistory().some((entry) => entry.binds[0] === "freshness:yield-data")).toBe(true);
  });

  it("publishes evaluated warning signals into the yield rankings cache", async () => {
    const db = makePublicationCacheDb();
    // Scoring evidence: without the benchmark registry the USD entry is the
    // hardcoded fallback (ageSeconds null) and the row is an unpublishable
    // stale-benchmark NR row under B13.
    mockHealthyRiskFreeRateCache();
    const actual = await vi.importActual<typeof YieldHelpers>("../yield-sync/yield-helpers");
    vi.spyOn(yieldHelpersModule, "detectWarningSignals").mockImplementation(actual.detectWarningSignals);

    mockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            makeDlYieldPool({ pool: "pool-sdai-1", project: "maker", symbol: "sDAI", tvlUsd: 1_000_000_000, apy: 9, apyBase: 1, apyReward: 8, apyMean30d: 3 }),
          ],
        },
      },
    ]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    const parsed = getYieldRankingsCachePayload(db) as {
      rankings: Array<{ warningSignals: string[] }>;
    };
    expect(parsed.rankings[0]?.warningSignals).toContain("reward-heavy");
  });

  it("continues when published-generation repair fails before history load", async () => {
    const db = makePublicationCacheDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(publicationModule, "repairPublishedYieldGenerationFromCache").mockRejectedValueOnce(
      new Error("repair failed"),
    );

    mockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            makeDlYieldPool({ pool: "pool-sdai-1", project: "maker", symbol: "sDAI", tvlUsd: 1_000_000_000, apy: 5.2, apyBase: 5.2, apyMean30d: 5.1 }),
          ],
        },
      },
    ]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    const warningRecords = warnSpy.mock.calls.flatMap(([message]) => {
      try {
        return [JSON.parse(String(message)) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    expect(warningRecords).toContainEqual(
      expect.objectContaining({
        event: "yield-generation-repair-failed",
        errorName: "Error",
        errorMessage: "repair failed",
      }),
    );
  });

  it("returns a degraded no-op result while the cleanup writer pause is armed", async () => {
    const db = makePublicationCacheDb();
    const nowSec = Math.floor(Date.now() / 1000);
    installYieldCacheReader(vi.mocked(getCache), {
      "yield-history-cleanup:writer-pause": cacheRow({
            reason: "yield-history-cleanup",
            pausedAt: nowSec - 60,
            operator: "tester",
          }, nowSec - 60),
    });

    const result = await syncYieldData(db);

    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
    });
    expect(result.metadata).toContain('"writerPaused":true');
    expect(batchExecute).not.toHaveBeenCalled();
  });

  it("purges stale yield rows for refreshed coins after writing the current source set", async () => {
    const { db, sqlite } = pruneDb([
      ["100", "stale", 1749988799], ["usdc-circle", "stale", 1749988799],
      ["u-united-stables", "stale", 1749988799], ["lusd-liquity", "stale", 1749988799],
      ["usdc-circle", "current", 1749988800], ["usr-resolv", "frozen", 1749988799],
    ]);
    expect((await syncYieldData(db)).itemCount).toBe(1);
    expect(sqlite.prepare("SELECT stablecoin_id, source_key FROM yield_data ORDER BY stablecoin_id, source_key")
      .all().map(Object.values)).toEqual([
      ["100", "pool-sdai-1"], ["usdc-circle", "current"], ["usr-resolv", "frozen"],
    ]);
  });

  it("purges orphan yield rows for coins outside the tracked stablecoin set", async () => {
    const { db, sqlite } = pruneDb([
      ["orphan-coin", "orphan", 1749988800], ["legacy-coin", "legacy", 1749988800],
      ["usdc-circle", "current", 1749988800], ["usr-resolv", "frozen", 1749988799],
    ]);
    expect((await syncYieldData(db)).itemCount).toBe(1);
    expect(sqlite.prepare("SELECT stablecoin_id, source_key FROM yield_data ORDER BY stablecoin_id, source_key")
      .all().map(Object.values)).toEqual([
      ["100", "pool-sdai-1"], ["usdc-circle", "current"], ["usr-resolv", "frozen"],
    ]);
  });

  it("chunks stale-yield cleanup under the D1 bind limit", async () => {
    const db = makePublicationCacheDb();
    const originalLength = ACTIVE_STABLECOINS.length;
    mockHealthyRiskFreeRateCache();

    for (let i = 0; i < 120; i++) {
      mutableActiveStablecoins.push({
        id: `extra-${i}`,
        name: `Extra ${i}`,
        symbol: `E${i}`,
        geckoId: `extra-${i}`,
        flags: {
          pegCurrency: "USD",
          backing: ACTIVE_STABLECOINS[1]!.flags.backing,
          yieldBearing: false,
          rwa: false,
          navToken: false,
          governance: "centralized",
        },
      });
    }

    try {
      mockFetch([
        {
          match: "yields.llama.fi",
          body: {
            data: [
              makeDlYieldPool({ pool: "pool-sdai-1", project: "maker", symbol: "sDAI", tvlUsd: 1_000_000_000, apy: 5.2, apyBase: 5.2, apyMean30d: 5.1 }),
            ],
          },
        },
      ]);

      await syncYieldData(db);
    } finally {
      mutableActiveStablecoins.splice(originalLength);
    }

    const staleDeleteCalls = db
      .getHistory()
      .filter(
        (entry) =>
          entry.sql.includes("DELETE FROM yield_data") &&
          entry.sql.includes("stablecoin_id IN") &&
          entry.sql.includes("updated_at <"),
      );

    expect(staleDeleteCalls.length).toBeGreaterThan(1);
    expect(Math.max(...staleDeleteCalls.map((entry) => entry.binds.length))).toBeLessThanOrEqual(91);
  });

  it("uses cached DL pools from DEX sync when available", async () => {
    const db = makePublicationCacheDb();

    installYieldCacheReader(vi.mocked(getCache), {
      "dl-stablecoin-pools": cacheRow({
            updatedAt: Math.floor(Date.now() / 1000),
            source: "sync-dex-liquidity",
            poolCount: 1,
            data: [
              makeDlYieldPool({ pool: "pool-sdai-cached", project: "maker", symbol: "sDAI", tvlUsd: 900_000_000, apy: 4.8, apyBase: 4.8, apyMean30d: 4.7 }),
            ],
          }, Math.floor(Date.now() / 1000)),
    });

    // No DL yields API call should happen (pools already cached)
    const fetchSpy = mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    // Should NOT have fetched from yields.llama.fi since cached pools were available
    const yieldCalls = fetchSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("yields.llama.fi"),
    );
    expect(yieldCalls.length).toBe(0);
  });
});

describe("syncYieldData", () => {
  beforeEach(resetSyncYieldDataTest);
  afterEach(cleanupSyncYieldDataTest);
  it("labels yield-bearing auto-discovered rows as lending opportunities", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    installYieldCacheReader(vi.mocked(getCache), {
      "dl-stablecoin-pools": dlPoolsCacheRow([
            makeDlYieldPool({ pool: "pool-sdai-aave", project: "aave-v3", symbol: "aSDAI", tvlUsd: 5_000_000, apy: 3.25, apyBase: 3.25, apyMean30d: 3.25 }),
          ], nowSec - 60),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(yieldHelpersModule.findBestLendingPool).mockImplementation((symbol) =>
      symbol === "sDAI"
        ? {
            pool: "pool-sdai-aave",
            apy: 3.25,
            apyBase: 3.25,
            apyReward: null,
            apyMean30d: 3.25,
            tvlUsd: 5_000_000,
            project: "aave-v3",
          }
        : null,
    );
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.itemCount).toBe(1);
    const autoRow = findPublishedYieldRow(db, "100", (row) => row.data_source === "defillama-auto");
    expect(autoRow?.yield_source).toBe("Aave V3");
    expect(autoRow?.yield_type).toBe("lending-opportunity");
  });

  it("rejects undersized dynamic lending pools using the supply-relative TVL floor", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    installYieldCacheReader(vi.mocked(getCache), {
      stablecoins: cacheRow({
            peggedAssets: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                name: "USD Coin",
                price: 1,
                circulating: { peggedUSD: 10_000_000_000 },
              },
            ],
      }, nowSec),
      "dl-stablecoin-pools": dlPoolsCacheRow([
        makeDlYieldPool({ pool: "pool-undersized", project: "aave-v3", symbol: "USDC", tvlUsd: 5_000_000, apy: 9, apyBase: 9 }),
        makeDlYieldPool({ pool: "pool-qualified", project: "aave-v3", symbol: "USDC", tvlUsd: 10_000_000, apy: 3.25, apyBase: 3.25 }),
      ], nowSec - 60),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    const actual = await vi.importActual<typeof yieldHelpersModule>("../yield-sync/yield-helpers");
    vi.mocked(yieldHelpersModule.findBestLendingPool).mockImplementation(actual.findBestLendingPool);
    mockFetch([]);

    await syncYieldData(db);

    const row = findPublishedYieldRow(db, "usdc-circle", (candidate) => candidate.is_best === 1);
    expect(row?.source_key).toBe("pool-qualified");
    expect(row?.current_apy).toBe(3.25);
    expect(findPublishedYieldRow(db, "usdc-circle", (candidate) => candidate.source_key === "pool-undersized")).toBeUndefined();
  });

  it("publishes retained-benchmark input degradation as quality without failing the run", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    installYieldCacheReader(vi.mocked(getCache), {
      "dl-stablecoin-pools": dlPoolsCacheRow([
        makeDlYieldPool({ pool: "pool-sdai", project: "maker", symbol: "sDAI", apy: 5, apyBase: 5 }),
      ], nowSec - 60),
      risk_free_rate: cacheRow({
            rate: 3.71,
            recordDate: "2025-06-13",
            fetchedAt: nowSec - 6 * 3600,
            source: "fred-dgs3mo",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }, nowSec - 6 * 3600),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      quality: { degraded: boolean; reasons: string[] };
    };

    expect(result.status).toBe("ok");
    expect(metadata.quality.reasons).toContain("risk-free-rate:fred-api-error-retained");

    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      provenance: { benchmark: { fallbackMode: string | null; isFallback: boolean } };
    };
    expect(rankingsPayload.provenance.benchmark.fallbackMode).toBe("fred-api-error-retained");
    expect(rankingsPayload.provenance.benchmark.isFallback).toBe(true);
  });

  it("publishes the only source unscored when its retained benchmark is stale", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    installYieldCacheReader(vi.mocked(getCache), {
      "dl-stablecoin-pools": dlPoolsCacheRow([
        makeDlYieldPool({ pool: "pool-sdai", project: "maker", symbol: "sDAI", apy: 5, apyBase: 5 }),
      ], nowSec - 60),
      risk_free_rate: cacheRow({
            rate: 3.71,
            recordDate: "2025-06-10",
            fetchedAt: nowSec - 49 * 3600,
            source: "fred-dgs3mo",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }, nowSec - 49 * 3600),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      quality: { degraded: boolean; reasons: string[] };
    };
    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      rankings: Array<{ id: string; pharosYieldScore: number | null; pysNullReason: string | null }>;
    };

    // A stale hurdle withholds the PYS and names the retained benchmark as
    // input quality; it does not withdraw the fresh observed row, so the run
    // still publishes (see yield-evaluation: benchmark-stale keeps rejected false).
    expect(result.status).toBe("ok");
    expect(metadata.quality.degraded).toBe(true);
    expect(metadata.quality.reasons).toContain("risk-free-rate:fred-api-error-retained");
    expect(rankingsPayload.rankings).toHaveLength(1);
    const [ranking] = rankingsPayload.rankings;
    expect(ranking).toMatchObject({ pharosYieldScore: null, pysNullReason: "benchmark-stale" });
    expect(findPublishedYieldRow(db, ranking.id, (row) => row.is_best === 1)?.pharos_yield_score).toBeNull();
  });

  it.each([
    ["empty snapshot coverage", "stablecoins-cache:missing-cache"],
    ["active V9 marker", "active-safety-score:v9"],
    ["malformed V9 marker", "active-safety-score:activation-marker-invalid"],
    ["mismatched V9 identity", "active-safety-score:v9-identity-mismatch"],
  ])("defers publication on the upstream reason when no accepted safety publication is readable for %s", async (_label, reason) => {
    const db = makeDb();
    installYieldCacheReader(vi.mocked(getCache), {});
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);
    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValue(
      testSafetyScoresSnapshot({
        kind: "degraded",
        reason,
        safetyScoreIdentity: null,
      }),
    );

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      safetySnapshotSource: string;
      safetyScoresComputed: number;
      safetyScoresExpected: number | null;
      safetyScoreIdentity: unknown;
    };

    // R2: an unusable published snapshot is an input outage, not a measurement
    // of zero. Every evaluated row would be forced to `NR` and dropped from the
    // publication views, so continuing would publish an empty ranking set and
    // report it as `published-yield-coverage-regression` — blaming yield sources
    // for a safety outage. The run defers and names the upstream reason verbatim.
    expect(result.status).toBe("degraded");
    expect(result.itemCount).toBe(0);
    expect(metadata.reason).toBe(`safety-snapshot-unavailable:${reason}`);
    expect(metadata.safetySnapshotSource).toBe("safety-score-v9-publication");
    expect(metadata.safetyScoresComputed).toBe(0);
    expect(metadata.safetyScoresExpected).toBeNull();
    expect(metadata.safetyScoreIdentity).toBeNull();
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
    expect(findPublishedYieldRow(db, "lusd-liquity", () => true)).toBeUndefined();
    expect(findPublishedYieldHistoryRow(db, "lusd-liquity", () => true)).toBeUndefined();
    expect(vi.mocked(setCacheIfNewer).mock.calls.some((call) => call[1] === "report_card_cache")).toBe(false);
  });

  it("still publishes a usable but coverage-degraded published safety snapshot", async () => {
    const db = makeDb();
    installYieldCacheReader(vi.mocked(getCache), {
      "dl-stablecoin-pools": dlPoolsCacheRow([
        makeDlYieldPool({ pool: "pool-sdai", project: "maker", symbol: "sDAI", apy: 5, apyBase: 5 }),
      ], Math.floor(Date.now() / 1000)),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);
    // Usable identity with a partial score map (coverage below the 0.75 degraded
    // ratio): the input gate keys on usability, so this must stay publishable.
    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValue(
      testSafetyScoresSnapshot({
        trackedCount: 4,
        scores: new Map([
          ["lusd-liquity", { score: 86, grade: "A-" }],
          ["100", { score: 80, grade: "B+" }],
        ]),
      }),
    );

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as { quality: { degraded: boolean; reasons: string[] } };

    expect(result.status).toBe("ok");
    expect(metadata.quality.reasons).toContain("safety-snapshot-coverage");
    expect(getYieldRankingsCachePayload(db)).toBeDefined();
  });

  it("fails the run instead of reporting a malformed supply map when the bulk stablecoin read fails", async () => {
    const db = makeDb();
    installYieldCacheReader(vi.mocked(getCache), {
      // R2: an unreachable cache row is not evidence that the payload is
      // malformed, so it must not degrade into an empty supply map.
      stablecoins: { throw: new Error("D1_ERROR: Currently processing a long-running import.") },
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    await expect(syncYieldData(db)).rejects.toThrow("Currently processing a long-running import");
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
  });

  it.each([0.25, 0.75])("publishes held accepted evidence at the 24h boundary with coverage %s", async (coverageRatio) => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const nativePoolMap = yieldPools.YIELD_POOL_MAP as Record<string, string>;
    nativePoolMap["100"] = "pool-sdai-native";
    const acceptedPublicationGenerationId = "report-cards:v9:accepted";

    installYieldCacheReader(vi.mocked(getCache), {
      "dl-stablecoin-pools": dlPoolsCacheRow([
            makeDlYieldPool({ pool: "pool-sdai-native", project: "maker", symbol: "sDAI", tvlUsd: 100_000_000, apy: 4.5, apyBase: 4.5, apyMean30d: 4.4 }),
            {
              pool: "pool-lusd-aave",
              chain: "Ethereum",
              project: "aave-v3",
              symbol: "LUSD",
              tvlUsd: 10_000_000,
              apy: 3.5,
              apyBase: 3.5,
              apyReward: null,
              apyMean30d: 3.4,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: ["0x5f98805a4e8be255a32880fdec7f6728c6568ba0"],
            },
          ], nowSec - 60),
      risk_free_rate: cacheRow({
            rate: 4,
            source: "fred-dgs3mo",
            fetchedAt: nowSec,
            recordDate: "2025-06-13",
            isFallback: false,
            fallbackMode: null,
          }, nowSec),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);
    // Held health with the accepted generation still inside the read path's
    // stale-coherent budget: the report-card route serves exactly these ratings,
    // so yield must publish against them instead of deferring.
    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValue(
      testSafetyScoresSnapshot({
        kind: "degraded",
        reason: "v9-publication-held",
        trackedCount: 4,
        scores: new Map([
          ["lusd-liquity", { score: 86, grade: "A-" }],
          ...(coverageRatio >= 0.75 ? [
            ["100", { score: 80, grade: "B+" }] as const,
            ["usdc-circle", { score: 78, grade: "B+" }] as const,
          ] : []),
        ]),
        safetyScoreIdentity: testSafetyScoreIdentity({
          publicationGenerationId: acceptedPublicationGenerationId,
        }),
        publishedAt: nowSec - 24 * 3600,
      }),
    );

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as { quality: { degraded: boolean; reasons: string[]; advisoryReasons: string[] } };
    const payload = getYieldRankingsCachePayload(db) as {
      rankings: Array<{ id: string; safetyScore: number | null; safetyGrade: string }>;
      provenance: { safetySnapshot: { safetyScoreIdentity: { publicationGenerationId: string } | null; trackedCount: number | null; coverageRatio: number | null; reason: string | null } };
    } | undefined;

    expect(result.status).toBe("ok");
    expect(metadata.quality.advisoryReasons).toContain("safety-snapshot-held");
    expect(metadata.quality.reasons.includes("safety-snapshot-coverage")).toBe(coverageRatio < 0.75);
    expect(payload).toBeDefined();
    expect(payload?.provenance.safetySnapshot.safetyScoreIdentity?.publicationGenerationId)
      .toBe(acceptedPublicationGenerationId);
    expect(payload?.provenance.safetySnapshot).toMatchObject({
      trackedCount: 4, coverageRatio, reason: "v9-publication-held",
    });
    // The accepted generation's safety reached the row instead of the old
    // all-NR collapse that withheld the publication.
    expect(findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "pool-lusd-aave"))
      .toMatchObject({ safety_score: 86, safety_grade: "A" });
    // The hold stays observable without misclassifying adequate coverage.
    expect(result.itemCount).toBeGreaterThan(0);
  });

  it.each(["expired", "missing", "future", "nonfinite"] as const)("defers held evidence with %s publication clock", async (clock) => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    installYieldCacheReader(vi.mocked(getCache), {});
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);
    vi.spyOn(safetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValue(
      testSafetyScoresSnapshot({
        kind: "degraded",
        reason: "v9-publication-held",
        trackedCount: 4,
        scores: new Map([["lusd-liquity", { score: 86, grade: "A-" }]]),
        safetyScoreIdentity: testSafetyScoreIdentity({
          publicationGenerationId: "report-cards:v9:stale-accepted",
        }),
        publishedAt: clock === "expired" ? nowSec - 24 * 3600 - 1
          : clock === "missing" ? null : clock === "future" ? nowSec + 1 : Number.NaN,
      }),
    );

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      safetySnapshotHeld: boolean;
      acceptedPublicationAgeSeconds: number;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.reason).toBe("safety-snapshot-unavailable:safety-publication-clock-out-of-budget");
    expect(metadata.safetySnapshotHeld).toBe(true);
    if (clock === "expired") expect(metadata.acceptedPublicationAgeSeconds).toBe(24 * 3600 + 1);
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
  });

  it("skips destructive yield row cleanup on input-quality-degraded publications", async () => {
    const db = mockD1WithYieldPruneTables(yieldFallbackTableMatches());
    const nowSec = Math.floor(Date.now() / 1000);

    installYieldCacheReader(vi.mocked(getCache), {
      "dl-stablecoin-pools": dlPoolsCacheRow([
            makeDlYieldPool({ pool: "pool-sdai-cached", project: "maker", symbol: "sDAI", tvlUsd: 900_000_000, apy: 4.8, apyBase: 4.8, apyMean30d: 4.7 }),
          ], nowSec),
      risk_free_rate: cacheRow({
            rate: 4.0,
            source: "fred",
            fetchedAt: nowSec - 6 * 3600,
            recordDate: "2025-06-13",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }, nowSec - 6 * 3600),
    });
    vi.mocked(shouldAttemptFetch).mockResolvedValue(false);
    mockFetch([]);

    const result = await syncYieldData(db);

    expect(result.status).toBe("ok");
    expect(JSON.parse(result.metadata ?? "{}").quality.degraded).toBe(true);
    const staleDeleteCall = db
      .getHistory()
      .find((entry) => entry.sql.includes("DELETE FROM yield_data") && entry.sql.includes("updated_at <"));
    const orphanDeleteCall = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("DELETE FROM yield_data") &&
          entry.sql.includes("stablecoin_id IN") &&
          !entry.sql.includes("updated_at <"),
      );

    expect(staleDeleteCall).toBeUndefined();
    expect(orphanDeleteCall).toBeUndefined();
  });
});
