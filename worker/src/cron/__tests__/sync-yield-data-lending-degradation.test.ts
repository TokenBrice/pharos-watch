import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDb,
  findPublishedYieldRow,
  findPublishedYieldHistoryRow,
  getYieldRankingsCachePayload,
  mockD1WithYieldPruneTables,
  yieldFallbackTableMatches,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
  testSafetyScoreIdentity,
  testSafetyScoresSnapshot,
} from "./sync-yield-data.test-support";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { syncYieldData } from "../sync-yield-data";
import * as yieldHelpersModule from "../yield-helpers";
import { getCache, setCacheIfNewer } from "../../lib/db-cache";
import { shouldAttemptFetch } from "../../lib/circuit-breaker";
import * as safetyScoresModule from "../../lib/safety-scores";
import * as yieldConfigModule from "../../lib/yield-config/yield-config";
import { cacheRow, dlPoolsCacheRow, installYieldCacheReader } from "./yield-cache.test-support";
import { makeDlYieldPool } from "./yield-resolve.test-support";

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
    const actual = await vi.importActual<typeof yieldHelpersModule>("../yield-helpers");
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

  it("defers publication when a stale retained benchmark disqualifies the only source", async () => {
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
      reason: string;
      inputDiagnostics: { evaluatedSourceCount: number; rejectedSourceCount: number };
    };

    expect(result.status).toBe("degraded");
    expect(metadata.reason).toBe("rankings-payload-shrunk");
    expect(metadata.inputDiagnostics.evaluatedSourceCount).toBe(1);
    expect(metadata.inputDiagnostics.rejectedSourceCount).toBe(1);
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
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
        trackedCount: 4,
        safetyScoreIdentity: null,
      }),
    );

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      safetySnapshotSource: string;
      safetyScoresComputed: number;
      safetyScoresExpected: number;
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
    expect(metadata.safetyScoresExpected).toBe(4);
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

  it("publishes from the accepted generation while the newest V9 attempt is held inside the budget", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const nativePoolMap = yieldConfigModule.YIELD_POOL_MAP as Record<string, string>;
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
        scores: new Map([["lusd-liquity", { score: 86, grade: "A-" }]]),
        safetyScoreIdentity: testSafetyScoreIdentity({
          publicationGenerationId: acceptedPublicationGenerationId,
        }),
        publishedAt: nowSec - 2 * 3600,
      }),
    );

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as { quality: { degraded: boolean; reasons: string[] } };
    const payload = getYieldRankingsCachePayload(db) as {
      rankings: Array<{ id: string; safetyScore: number | null; safetyGrade: string }>;
      provenance: { safetySnapshot: { safetyScoreIdentity: { publicationGenerationId: string } | null } };
    } | undefined;

    expect(result.status).toBe("ok");
    expect(metadata.quality.reasons).toContain("safety-snapshot:v9-publication-held");
    expect(payload).toBeDefined();
    expect(payload?.provenance.safetySnapshot.safetyScoreIdentity?.publicationGenerationId)
      .toBe(acceptedPublicationGenerationId);
    // The accepted generation's safety reached the row instead of the old
    // all-NR collapse that withheld the publication.
    expect(findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "pool-lusd-aave"))
      .toMatchObject({ safety_score: 86, safety_grade: "A" });
    // The hold is recorded, never laundered into a clean run.
    expect(result.itemCount).toBeGreaterThan(0);
  });

  it("defers when the held accepted publication is past the stale-coherent budget", async () => {
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
        publishedAt: nowSec - 25 * 3600,
      }),
    );

    const result = await syncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string;
      safetySnapshotHeld: boolean;
      acceptedPublicationAgeSeconds: number;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.reason).toBe("safety-snapshot-unavailable:v9-publication-held");
    expect(metadata.safetySnapshotHeld).toBe(true);
    expect(metadata.acceptedPublicationAgeSeconds).toBeGreaterThan(24 * 3600);
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
