import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mutableActiveStablecoins,
  makeStablecoinsCacheValue,
  getPublishedYieldRows,
  getYieldRankingsCachePayload,
  mockHealthyRiskFreeRateCache,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
  fixtureSyncYieldData,
  fixtureMockD1,
  fixtureBatchExecute,
  fixtureGetCache,
  fixtureWriteFreshnessSentinel,
  fixtureShouldAttemptFetch,
  fixtureMockFetch,
  fixtureACTIVE_STABLECOINS,
  fixtureSafetyScoreActiveSourceModule,
  fixtureSafetyScoresModule,
  fixtureYieldHelpersModule,
  fixturePublicationModule,
  fixtureYIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY,
  type CronProgressUpdate,
} from "./sync-yield-data.test-support";

function makePublicationCacheDb(existingIds: Record<string, unknown>[] = []) {
  return fixtureMockD1([
    { match: "pharos:yield-sync:yield-data-existing-ids", rows: existingIds },
    { match: "cache", rows: [] },
    { match: "yield_data", rows: [] },
    { match: "yield_history", rows: [] },
    { match: "supply_history", rows: [] },
    { match: "depeg_events", rows: [] },
    { match: "dex_liquidity", rows: [] },
    { match: "ranked_linked_generations", rows: [] },
    { match: "pharos:yield-sync:decision-retention-delete", rows: [] },
    { match: "pharos:yield-sync:decision-alternatives-retention-delete", rows: [] },
    { match: "source_switch = 0", rows: [] },
  ]);
}

describe("syncYieldData", () => {
  beforeEach(resetSyncYieldDataTest);
  afterEach(cleanupSyncYieldDataTest);
  it("syncs yield data from DeFiLlama pools on normal path", async () => {
    const db = makePublicationCacheDb();

    // DL yields API returns a pool matching sDAI
    fixtureMockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            {
              pool: "pool-sdai-1",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyReward: null,
              apyMean30d: 5.1,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    const result = await fixtureSyncYieldData(db);

    // Should have updated 1 yield-bearing coin
    expect(result.itemCount).toBe(1);
    expect(getPublishedYieldRows(db)).toHaveLength(1);
    expect(getYieldRankingsCachePayload(db)).toBeDefined();
    expect(fixtureWriteFreshnessSentinel).toHaveBeenCalledWith(
      db,
      "yield-data",
      Math.floor(Date.now() / 1000),
      undefined,
    );
  });

  it("loads stablecoin supply once and requests the published safety generation", async () => {
    const db = makePublicationCacheDb();
    const updatedAt = Math.floor(Date.now() / 1000);
    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "stablecoins") {
        return { value: makeStablecoinsCacheValue(), updatedAt };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const stablecoinsReads = vi.mocked(fixtureGetCache).mock.calls.filter((call) => call[1] === "stablecoins");
    const safetyCalls = vi.mocked(fixtureSafetyScoresModule.computeSafetyScoresSnapshot).mock.calls;
    const safetyCall = safetyCalls[safetyCalls.length - 1];

    expect(stablecoinsReads).toHaveLength(1);
    expect(safetyCall?.[0]).toBe(db);
  });

  it("blocks yield publication when the safety identity changes before publish", async () => {
    const db = makePublicationCacheDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const safetySnapshot = vi.mocked(fixtureSafetyScoresModule.computeSafetyScoresSnapshot);
    const currentSafetyIdentity = vi.mocked(
      fixtureSafetyScoreActiveSourceModule.loadActiveSafetyScoreIdentity,
    );
    safetySnapshot
      .mockResolvedValueOnce({
        kind: "ok",
        mode: "map",
        coveredCount: 4,
        trackedCount: 4,
        coverageRatio: 1,
        source: "safety-score-v9-publication",
        safetyScoreIdentity: {
          model: "v9",
          schemaVersion: 1,
          methodologyVersion: "9.0",
          policyId: "safety-score-v9",
          policyDigest: "a".repeat(64),
          evaluationBuildDigest: "b".repeat(64),
          baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
          publicationGenerationId: "report-cards:v9:test",
        },
        publicationGenerationId: "report-cards:v9:test",
        methodologyVersion: "9.0",
        publishedAt: nowSec,
        scores: new Map([
          ["100", { score: 80, grade: "B+" }],
          ["usdc-circle", { score: 78, grade: "B+" }],
          ["u-united-stables", { score: 55, grade: "C" }],
          ["lusd-liquity", { score: 86, grade: "A-" }],
        ]),
      } as never);
    currentSafetyIdentity.mockResolvedValue({
      kind: "v9",
      safetyScoreIdentity: {
        model: "v9",
        schemaVersion: 1,
        methodologyVersion: "9.0",
        policyId: "safety-score-v9",
        policyDigest: "a".repeat(64),
        evaluationBuildDigest: "d".repeat(64),
        baseInputGenerationId: `report-cards-input:v1:${"e".repeat(64)}`,
        publicationGenerationId: "report-cards:v9:new-build",
      },
    });

    fixtureMockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            {
              pool: "pool-sdai-1",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyReward: null,
              apyMean30d: 5.1,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    const result = await fixtureSyncYieldData(db);

    expect(safetySnapshot).toHaveBeenCalledTimes(1);
    expect(currentSafetyIdentity).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
      productivity: {
        productive: false,
        reason: "yield-safety-identity-changed-before-publish",
      },
    });
    expect(result.metadata).toContain("yield-safety-identity-changed-before-publish");
    expect(getPublishedYieldRows(db)).toEqual([]);
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
    expect(fixtureWriteFreshnessSentinel).not.toHaveBeenCalled();
  });

  it("reports writer-pause progress metadata before returning", async () => {
    const db = makePublicationCacheDb();
    const progressUpdates: CronProgressUpdate[] = [];
    const reportProgress = vi.fn(async (update: CronProgressUpdate) => {
      progressUpdates.push(update);
    });
    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === fixtureYIELD_HISTORY_CLEANUP_WRITER_PAUSE_KEY) {
        return {
          value: JSON.stringify({
            reason: "history-cleanup",
            operator: "ops",
            pausedAt: Math.floor(Date.now() / 1000) - 60,
          }),
          updatedAt: Math.floor(Date.now() / 1000) - 60,
        };
      }
      return null;
    });

    const result = await fixtureSyncYieldData(db, undefined, undefined, undefined, undefined, reportProgress);
    const writerPaused = progressUpdates.find((update) => update.stage === "writer-paused");

    expect(result.status).toBe("degraded");
    expect(writerPaused).toMatchObject({
      stage: "writer-paused",
      metadata: {
        providerFamily: "yield",
        phase: "writer-paused",
        writerPaused: true,
        countTotals: {
          yieldBearingCoins: expect.any(Number),
          opportunityCoins: expect.any(Number),
          totalTrackedForYield: expect.any(Number),
        },
      },
    });
  });

  it("publishes evaluated warning signals into the yield rankings cache", async () => {
    const db = makePublicationCacheDb();
    vi.mocked(fixtureYieldHelpersModule.detectWarningSignals).mockReturnValue(["yield-spike"]);

    fixtureMockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            {
              pool: "pool-sdai-1",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 9,
              apyBase: 9,
              apyReward: null,
              apyMean30d: 3,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBe(1);
    const parsed = getYieldRankingsCachePayload(db) as {
      rankings: Array<{ warningSignals: string[] }>;
    };
    expect(parsed.rankings[0]?.warningSignals).toContain("yield-spike");
  });

  it("continues when published-generation repair fails before history load", async () => {
    const db = makePublicationCacheDb();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(fixturePublicationModule, "repairPublishedYieldGenerationFromCache").mockRejectedValueOnce(
      new Error("repair failed"),
    );

    fixtureMockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            {
              pool: "pool-sdai-1",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyReward: null,
              apyMean30d: 5.1,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    const result = await fixtureSyncYieldData(db);

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
    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield-history-cleanup:writer-pause") {
        return {
          value: JSON.stringify({
            reason: "yield-history-cleanup",
            pausedAt: nowSec - 60,
            operator: "tester",
          }),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });

    const result = await fixtureSyncYieldData(db);

    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
    });
    expect(result.metadata).toContain('"writerPaused":true');
    expect(fixtureBatchExecute).not.toHaveBeenCalled();
  });

  it("purges stale yield rows for refreshed coins after writing the current source set", async () => {
    const db = makePublicationCacheDb();
    mockHealthyRiskFreeRateCache();

    fixtureMockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            {
              pool: "pool-sdai-1",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyReward: null,
              apyMean30d: 5.1,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    await fixtureSyncYieldData(db);

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

    fixtureMockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            {
              pool: "pool-sdai-1",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyReward: null,
              apyMean30d: 5.1,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ],
        },
      },
    ]);

    await fixtureSyncYieldData(db);

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
    const originalLength = fixtureACTIVE_STABLECOINS.length;
    mockHealthyRiskFreeRateCache();

    for (let i = 0; i < 120; i++) {
      mutableActiveStablecoins.push({
        id: `extra-${i}`,
        name: `Extra ${i}`,
        symbol: `E${i}`,
        geckoId: `extra-${i}`,
        flags: {
          pegCurrency: "USD",
          backing: fixtureACTIVE_STABLECOINS[1]!.flags.backing,
          yieldBearing: false,
          rwa: false,
          navToken: false,
          governance: "centralized",
        },
      });
    }

    try {
      fixtureMockFetch([
        {
          match: "yields.llama.fi",
          body: {
            data: [
              {
                pool: "pool-sdai-1",
                chain: "Ethereum",
                project: "maker",
                symbol: "sDAI",
                tvlUsd: 1_000_000_000,
                apy: 5.2,
                apyBase: 5.2,
                apyReward: null,
                apyMean30d: 5.1,
                stablecoin: true,
                exposure: "single",
                underlyingTokens: null,
              },
            ],
          },
        },
      ]);

      await fixtureSyncYieldData(db);
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
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
      return null;
    });

    // No DL yields API call should happen (pools already cached)
    const fetchSpy = fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBe(1);
    // Should NOT have fetched from yields.llama.fi since cached pools were available
    const yieldCalls = fetchSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("yields.llama.fi"),
    );
    expect(yieldCalls.length).toBe(0);
  });
});
