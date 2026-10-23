import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mutableActiveStablecoins,
  makeStablecoinsCacheValue,
  getPublishedYieldRows,
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
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { syncYieldData } from "../sync-yield-data";
import * as yieldHelpersModule from "../yield-helpers";
import * as publicationModule from "../yield-sync/publication";
import { batchExecute } from "../../lib/db";
import { getCache } from "../../lib/db-cache";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import * as safetyScoreActiveSourceModule from "../../lib/safety-score-active-source";
import * as safetyScoresModule from "../../lib/safety-scores";
import { cacheRow, installYieldCacheReader } from "./yield-cache.test-support";
import { makeDlYieldPool } from "./yield-resolve.test-support";
import type * as YieldHelpers from "../yield-helpers";
import type { YieldRankingsResponse } from "@shared/types/yield";

function makePublicationCacheDb(existingIds: Record<string, unknown>[] = []) {
  return mockD1WithYieldPruneTables(yieldFallbackTableMatches(
    existingIds.length > 0
      ? [{ match: "pharos:yield-sync:yield-data-existing-ids", rows: existingIds }]
      : [],
  ));
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

    // Should have updated 1 yield-bearing coin
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
    expect(safetyCall?.[0]).toBe(db);
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
    const actual = await vi.importActual<typeof YieldHelpers>("../yield-helpers");
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
    const db = makePublicationCacheDb();
    mockHealthyRiskFreeRateCache();

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

    const deleteCall = db
      .getHistory()
      .find((entry) => entry.sql.includes("DELETE FROM yield_data") && entry.sql.includes("stablecoin_id IN"));

    expect(deleteCall).toBeDefined();
    expect(deleteCall?.binds).toEqual(
      expect.arrayContaining(["100", "usdc-circle", "u-united-stables", "lusd-liquity"]),
    );
    expect(deleteCall?.binds[deleteCall.binds.length - 1]).toBe(Math.floor(Date.now() / 1000));
  });

  it("purges orphan yield rows for coins outside the tracked stablecoin set", async () => {
    const db = makePublicationCacheDb([
      { stablecoin_id: "orphan-coin" },
      { stablecoin_id: "legacy-coin" },
    ]);
    mockHealthyRiskFreeRateCache();

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

    const orphanScanCall = db
      .getHistory()
      .find((entry) => entry.sql.includes("pharos:yield-sync:yield-data-existing-ids"));

    expect(orphanScanCall).toBeDefined();

    const orphanDeleteCall = db
      .getHistory()
      .find(
        (entry) =>
          entry.sql.includes("DELETE FROM yield_data") &&
          entry.sql.includes("stablecoin_id IN") &&
          !entry.sql.includes("updated_at <"),
      );

    expect(orphanDeleteCall).toBeDefined();
    expect(orphanDeleteCall?.binds).toEqual(expect.arrayContaining(["orphan-coin", "legacy-coin"]));
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

    // Simulate cached pools from DEX sync
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
