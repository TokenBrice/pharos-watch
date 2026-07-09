import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDb,
  findPublishedYieldRow,
  getYieldRankingsCachePayload,
  makeYieldOrphanDb,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
  fixtureSyncYieldData,
  fixtureGetCache,
  fixtureSetCacheIfNewer,
  fixtureShouldAttemptFetch,
  fixtureMockFetch,
  fixtureSafetyScoresModule,
  fixtureYieldHelpersModule,
} from "./sync-yield-data.test-support";

describe("syncYieldData", () => {
  beforeEach(resetSyncYieldDataTest);
  afterEach(cleanupSyncYieldDataTest);
  it("labels yield-bearing auto-discovered rows as lending opportunities", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-placeholder",
              chain: "Ethereum",
              project: "aave-v3",
              symbol: "USDC",
              tvlUsd: 5_000_000,
              apy: 3.25,
              apyBase: 3.25,
              apyReward: null,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureYieldHelpersModule.findBestLendingPool).mockImplementation((symbol) =>
      symbol === "sDAI"
        ? {
            pool: "pool-sdai-aave",
            apy: 3.25,
            apyBase: 3.25,
            apyReward: null,
            tvlUsd: 5_000_000,
            project: "aave-v3",
          }
        : null,
    );
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBe(1);
    const autoRow = findPublishedYieldRow(db, "100", (row) => row.data_source === "defillama-auto");
    expect(autoRow?.yield_source).toBe("Aave V3");
    expect(autoRow?.yield_type).toBe("lending-opportunity");
  });

  it("passes a supply-relative TVL floor into dynamic lending discovery", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "stablecoins") {
        return {
          value: JSON.stringify({
            peggedAssets: [
              {
                id: "usdc-circle",
                symbol: "USDC",
                name: "USD Coin",
                price: 1,
                circulating: { peggedUSD: 10_000_000_000 },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-placeholder",
              chain: "Ethereum",
              project: "aave-v3",
              symbol: "USDC",
              tvlUsd: 5_000_000,
              apy: 3.25,
              apyBase: 3.25,
              apyReward: null,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureYieldHelpersModule.findBestLendingPool).mockReturnValue(null);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const usdcDiscoveryCall = vi
      .mocked(fixtureYieldHelpersModule.findBestLendingPool)
      .mock.calls.find((call) => call[0] === "USDC");
    expect(usdcDiscoveryCall?.[2]).toEqual(expect.any(Set));
    expect(usdcDiscoveryCall?.[3]).toMatchObject({
      minApy: 0.5,
      minTvlUsd: 10_000_000,
    });
  });

  it("marks the run degraded when a retained benchmark is in fallback mode, even if recent", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([]),
          updatedAt: nowSec - 6 * 3600,
        };
      }
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 3.71,
            recordDate: "2025-06-13",
            fetchedAt: nowSec - 6 * 3600,
            source: "fred-dgs3mo",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }),
          updatedAt: nowSec - 6 * 3600,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toContain("risk-free-rate:fred-api-error-retained");

    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      provenance: { benchmark: { fallbackMode: string | null; isFallback: boolean } };
    };
    expect(rankingsPayload.provenance.benchmark.fallbackMode).toBe("fred-api-error-retained");
    expect(rankingsPayload.provenance.benchmark.isFallback).toBe(true);
  });

  it("marks yield sync degraded when the retained benchmark is older than two days", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([]),
          updatedAt: nowSec - 49 * 3600,
        };
      }
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 3.71,
            recordDate: "2025-06-10",
            fetchedAt: nowSec - 49 * 3600,
            source: "fred-dgs3mo",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }),
          updatedAt: nowSec - 49 * 3600,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode).toContain("risk-free-rate:fred-api-error-retained");
  });

  it("marks run degraded but still writes yield-rankings cache when safety snapshot coverage is empty", async () => {
    const db = makeDb();
    vi.mocked(fixtureGetCache).mockResolvedValue(null);
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    vi.spyOn(fixtureSafetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValueOnce({
      kind: "degraded",
      mode: "map",
      coveredCount: 0,
      trackedCount: 4,
      coverageRatio: 0,
      reason: "stablecoins-cache:missing-cache",
      scores: new Map(),
    } as never);

    const result = await fixtureSyncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode: string | null;
      cacheWriteSkipped: boolean;
      sourceCoverage: { safetyCoverageRatio: number };
    };
    expect(metadata.fallbackMode ?? "").toContain("safety-snapshot-coverage");
    expect(metadata.cacheWriteSkipped).toBe(false);
    expect(metadata.sourceCoverage.safetyCoverageRatio).toBe(0);

    expect(getYieldRankingsCachePayload(db)).toBeDefined();
    expect(vi.mocked(fixtureSetCacheIfNewer).mock.calls.some((call) => call[1] === "report_card_cache")).toBe(false);
  });

  it("skips destructive yield row cleanup on degraded runs", async () => {
    const db = makeYieldOrphanDb(["orphan-coin"]);
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-cached",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 900_000_000,
              apy: 4.8,
              apyBase: 4.8,
              apyReward: null,
              apyMean30d: 4.7,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec,
        };
      }
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 4.0,
            source: "fred",
            fetchedAt: nowSec - 50 * 3600,
            recordDate: "2026-03-20",
            isFallback: true,
            fallbackMode: "fred-api-error-retained",
          }),
          updatedAt: nowSec - 50 * 3600,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.status).toBe("degraded");
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
