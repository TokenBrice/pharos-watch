import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mutableActiveStablecoins,
  mutableTrackedMetaById,
  makeDb,
  makeCacheWriteFailureDb,
  getPublishedYieldRows,
  findPublishedYieldRow,
  getYieldRankingsCachePayload,
  makeBrokenYieldRankingsDb,
  mockHealthyRiskFreeRateCache,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
  fixtureSyncYieldData,
  fixtureBatchExecute,
  fixtureGetCache,
  fixtureGetCaches,
  fixtureWriteFreshnessSentinel,
  fixtureShouldAttemptFetch,
  fixtureRecordOutcome,
  fixtureGetChainRpc,
  fixtureMockFetch,
  fixtureACTIVE_YIELD_BEARING_STABLECOINS,
  fixtureSafetyScoresModule,
  fixtureYieldConfigModule,
  fixturePublicationModule,
  type ChainRpcConfig,
} from "./sync-yield-data.test-support";

describe("syncYieldData", () => {
  beforeEach(resetSyncYieldDataTest);
  afterEach(cleanupSyncYieldDataTest);
  it("uses cached supplemental sources on the hourly publication path", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBe(1);
    const supplementalRow = findPublishedYieldRow(
      db,
      "100",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xvault",
    );
    expect(supplementalRow).toBeDefined();
    expect(vi.mocked(fixtureGetCaches)).toHaveBeenCalledWith(
      db,
      expect.arrayContaining(["yield:supplemental-sources:v1:morpho", "yield:supplemental-sources:v1:beefy"]),
    );
  });

  it("loads valid supplemental family caches even when another family cache is malformed", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1:morpho") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1:beefy") {
        return {
          value: "{bad json",
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: "{bad aggregate",
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBe(1);
    const supplementalRow = findPublishedYieldRow(
      db,
      "100",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xvault",
    );
    expect(supplementalRow).toBeDefined();
  });

  it("merges aggregate supplemental candidates for missing per-family caches", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1:morpho") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 2,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 5.8,
                  apyBase: 5.8,
                  apyReward: null,
                  sourcePool: "beefy-sdai",
                  sourceTvlUsd: 20_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:beefy:ethereum:beefy-sdai",
                  yieldSource: "Beefy: sDAI",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBe(2);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      sourceCoverage?: { supplementalFallbackMode?: string | null };
    };
    expect(metadata.sourceCoverage?.supplementalFallbackMode).toBe("partial-family-cache-aggregate-merge");
    const rows = getPublishedYieldRows(db);
    expect(
      rows.some(
        (row) => row.stablecoin_id === "100" && row.source_key === "protocol-api:morpho-vault:ethereum:0xvault",
      ),
    ).toBe(true);
    expect(
      rows.some((row) => row.stablecoin_id === "100" && row.source_key === "protocol-api:beefy:ethereum:beefy-sdai"),
    ).toBe(true);
  });

  it("keeps a higher native wrapper APY ahead of a lower supplemental lending source that clears size gates", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const poolMap = fixtureYieldConfigModule.YIELD_POOL_MAP as typeof fixtureYieldConfigModule.YIELD_POOL_MAP;
    poolMap["100"] = "pool-sdai-native";

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-sdai-native",
              chain: "Ethereum",
              project: "maker",
              symbol: "sDAI",
              tvlUsd: 84_819_532,
              apy: 4.45953,
              apyBase: 4.45953,
              apyReward: null,
              apyMean30d: 4.43603,
              stablecoin: true,
              exposure: "single",
              underlyingTokens: null,
            },
          ]),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 2.23864,
                  apyBase: 2.23864,
                  apyReward: null,
                  sourcePool: "vault-sdai-prime",
                  sourceTvlUsd: 25_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xsdai",
                  yieldSource: "Morpho: sDAI Prime",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    try {
      const result = await fixtureSyncYieldData(db);

      expect(result.itemCount).toBe(2);
      const nativeRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "pool-sdai-native");
      const supplementalRow = findPublishedYieldRow(
        db,
        "100",
        (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xsdai",
      );

      expect(nativeRow?.yield_source).toBe("DSR");
      expect(nativeRow?.data_source).toBe("defillama");
      expect(nativeRow?.is_best).toBe(1);
      expect(supplementalRow?.yield_source).toBe("Morpho: sDAI Prime");
      expect(supplementalRow?.data_source).toBe("protocol-api");
      expect(supplementalRow?.is_best).toBe(0);
    } finally {
      delete poolMap["100"];
    }
  });

  it("filters blocked USR-linked supplemental lending suggestions", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 2,
            data: [
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 8.5,
                  apyBase: 8.5,
                  apyReward: null,
                  sourcePool: "vault-resolv-usdc",
                  sourceTvlUsd: 25_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xresolv",
                  yieldSource: "Morpho: Resolv USDC",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 3.2,
                  apyBase: 3.2,
                  apyReward: null,
                  sourcePool: "vault-usdc-prime",
                  sourceTvlUsd: 30_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xusdc-prime",
                  yieldSource: "Morpho: USDC Prime",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const blockedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xresolv",
    );
    const allowedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xusdc-prime",
    );

    expect(blockedRow).toBeUndefined();
    expect(allowedRow).toBeDefined();
  });

  it("drops supplemental lending suggestions when venue TVL is unavailable", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 3.2,
                  apyBase: 3.2,
                  apyReward: null,
                  sourcePool: null,
                  sourceTvlUsd: null,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "aave-v3-onchain:ethereum:0xusdc",
                  yieldSource: "Aave v3 (ethereum)",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const droppedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "aave-v3-onchain:ethereum:0xusdc",
    );

    expect(droppedRow).toBeUndefined();
  });

  it("drops lending suggestions smaller than 0.1% of tracked stablecoin supply", async () => {
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
                circulating: { peggedUSD: 20_000_000_000 },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "USDC",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 4.1,
                  apyBase: 4.1,
                  apyReward: null,
                  sourcePool: "vault-usdc-small",
                  sourceTvlUsd: 5_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xusdc-small",
                  yieldSource: "Morpho: USDC Small",
                  yieldType: "lending-opportunity",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const droppedRow = findPublishedYieldRow(
      db,
      "usdc-circle",
      (row) => row.source_key === "protocol-api:morpho-vault:ethereum:0xusdc-small",
    );

    expect(droppedRow).toBeUndefined();
  });

  it("skips deterministic on-chain reads while cooldown is active", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x0000000000000000000000000000000000000001",
      method: "exchangeRate",
      scale: 1e18,
    } as never);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield:supplemental-sources:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            updatedAt: nowSec,
            source: "sync-yield-supplemental",
            sourceCount: 1,
            data: [
              {
                symbol: "sDAI",
                chain: "ethereum",
                address: null,
                yield: {
                  currentApy: 6.1,
                  apyBase: 6.1,
                  apyReward: null,
                  sourcePool: "vault-sdai-morpho",
                  sourceTvlUsd: 50_000_000,
                  dataSource: "protocol-api",
                  exchangeRate: null,
                  sourceKey: "protocol-api:morpho-vault:ethereum:0xvault",
                  yieldSource: "Morpho: sDAI Vault",
                  yieldType: "lending-vault",
                  sourceObservedAt: nowSec,
                  comparisonAnchorObservedAt: null,
                },
              },
            ],
          }),
          updatedAt: nowSec,
        };
      }
      if (key === "yield:onchain-health:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            consecutiveAllFailRuns: 2,
            consecutiveMaskedAllFailRuns: 2,
            cooldownUntil: nowSec + 3600,
            lastAttemptedAt: nowSec - 3600,
            lastAllFailedAt: nowSec - 3600,
            lastSuccessAt: null,
            lastSkippedAt: null,
            lastFailureMissingIds: [],
          }),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    const fetchSpy = fixtureMockFetch([]);

    try {
      const result = await fixtureSyncYieldData(db);
      const metadata = JSON.parse(result.metadata ?? "{}") as {
        sourceCoverage?: {
          onChainSkippedDueToCooldown?: boolean;
          onChainCooldownActive?: boolean;
        };
      };

      expect(result.itemCount).toBe(1);
      expect(metadata.sourceCoverage?.onChainSkippedDueToCooldown).toBe(true);
      expect(metadata.sourceCoverage?.onChainCooldownActive).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      onChainConfigs.length = 0;
    }
  });

  it("marks the run degraded when deterministic cooldown leaves a coverage gap", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x0000000000000000000000000000000000000001",
      method: "exchangeRate",
      scale: 1e18,
    } as never);

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
      if (key === "risk_free_rate") {
        return {
          value: JSON.stringify({
            rate: 4.0,
            source: "fred",
            fetchedAt: nowSec - 3600,
            recordDate: "2025-06-15",
            isFallback: false,
            fallbackMode: null,
          }),
          updatedAt: nowSec - 3600,
        };
      }
      if (key === "yield:onchain-health:v1") {
        return {
          value: JSON.stringify({
            version: 1,
            consecutiveAllFailRuns: 2,
            consecutiveMaskedAllFailRuns: 2,
            cooldownUntil: nowSec + 3600,
            lastAttemptedAt: nowSec - 3600,
            lastAllFailedAt: nowSec - 3600,
            lastSuccessAt: null,
            lastSkippedAt: null,
            lastFailureMissingIds: [],
          }),
          updatedAt: nowSec - 60,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    const fetchSpy = fixtureMockFetch([]);

    try {
      const result = await fixtureSyncYieldData(db);
      const metadata = JSON.parse(result.metadata ?? "{}") as {
        fallbackMode?: string | null;
        sourceCoverage?: {
          onChainSkippedDueToCooldown?: boolean;
          onChainAlternativeCoverageMissingIds?: string[];
        };
      };

      expect(result.status).toBe("degraded");
      expect(metadata.fallbackMode ?? "").toContain("onchain-rates:cooldown-coverage-gap");
      expect(metadata.sourceCoverage?.onChainSkippedDueToCooldown).toBe(true);
      expect(metadata.sourceCoverage?.onChainAlternativeCoverageMissingIds).toEqual(["100"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      onChainConfigs.length = 0;
    }
  });

  it("applies deterministic auto-discovery override for U (id 336)", async () => {
    const db = makeDb();

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-u-venus",
              chain: "BSC",
              project: "venus-core-pool",
              symbol: "U",
              tvlUsd: 15_000_000,
              apy: 2.4,
              apyBase: 2.4,
              apyReward: null,
              apyMean30d: 2.3,
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
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    // sDAI cannot resolve in this fixture; deterministic override should add U.
    expect(result.itemCount).toBe(1);
  });

  it("publishes curated exact-pool coverage for XAUT without enabling generic gold auto-discovery", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);
    const xautMeta = {
      id: "xaut-tether",
      name: "Tether Gold",
      symbol: "XAUT",
      geckoId: "tether-gold",
      flags: {
        pegCurrency: "GOLD",
        backing: "rwa-backed",
        yieldBearing: false,
        navToken: false,
        rwa: true,
        governance: "centralized",
      },
      contracts: [{ chain: "ethereum", address: "0x68749665ff8d2d112fa859aa293f07a622782f38", decimals: 6 }],
    };
    const explicitPoolMap =
      fixtureYieldConfigModule.EXPLICIT_YIELD_SOURCE_POOL_MAP as typeof fixtureYieldConfigModule.EXPLICIT_YIELD_SOURCE_POOL_MAP;

    mutableActiveStablecoins.push(xautMeta as never);
    mutableTrackedMetaById.set("xaut-tether", xautMeta as never);
    explicitPoolMap["xaut-tether"] = [
      {
        poolId: "pool-xaut-yo",
        yieldSource: "Yo Protocol",
        yieldType: "lending-opportunity",
        dataSource: "defillama",
        expectedProject: "yo-protocol",
        expectedSymbol: "XAUT",
        expectedChain: "ethereum",
      },
    ];

    vi.spyOn(fixtureSafetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 5,
      trackedCount: 5,
      coverageRatio: 1,
      scores: new Map([
        ["100", { score: 80, grade: "B+" }],
        ["usdc-circle", { score: 78, grade: "B+" }],
        ["u-united-stables", { score: 55, grade: "C" }],
        ["lusd-liquity", { score: 86, grade: "A-" }],
        ["xaut-tether", { score: 82, grade: "B+" }],
      ]),
    } as never);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-xaut-yo",
              chain: "Ethereum",
              project: "yo-protocol",
              symbol: "XAUT",
              tvlUsd: 3_200_000,
              apy: 11.4,
              apyBase: 11.4,
              apyReward: null,
              apyMean30d: 11.1,
              stablecoin: false,
              exposure: "single",
              underlyingTokens: ["0x68749665ff8d2d112fa859aa293f07a622782f38"],
            },
          ]),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    try {
      const result = await fixtureSyncYieldData(db);
      const xautRow = findPublishedYieldRow(db, "xaut-tether", (row) => row.source_key === "pool-xaut-yo");

      expect(result.itemCount).toBe(1);
      expect(xautRow?.yield_source).toBe("Yo Protocol");
      expect(xautRow?.yield_type).toBe("lending-opportunity");
      expect(xautRow?.data_source).toBe("defillama");
      expect(xautRow?.is_best).toBe(1);
    } finally {
      delete explicitPoolMap["xaut-tether"];
      mutableTrackedMetaById.delete("xaut-tether");
      mutableActiveStablecoins.pop();
    }
  });

  it("keeps deterministic override quality-gated (min TVL/APY/allowlist still apply)", async () => {
    const db = makeDb();

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "dl-stablecoin-pools") {
        return {
          value: JSON.stringify([
            {
              pool: "pool-u-venus",
              chain: "BSC",
              project: "venus-core-pool",
              symbol: "U",
              tvlUsd: 250_000, // below min TVL threshold
              apy: 2.4,
              apyBase: 2.4,
              apyReward: null,
              apyMean30d: 2.3,
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
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    // Override pool exists but fails min TVL gate, so nothing should be written.
    expect(result.itemCount).toBe(0);
  });

  it("adds conservative B.Protocol LQTY-only APR for LUSD and keeps lending as an alternative source", async () => {
    const db = makeDb();

    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    vi.spyOn(fixtureSafetyScoresModule, "computeSafetyScoresSnapshot").mockResolvedValueOnce({
      kind: "ok",
      mode: "map",
      coveredCount: 4,
      trackedCount: 4,
      coverageRatio: 1,
      scores: new Map([
        ["100", { score: 80, grade: "B+" }],
        ["usdc-circle", { score: 78, grade: "B+" }],
        ["u-united-stables", { score: 55, grade: "C" }],
        ["lusd-liquity", { score: 86, grade: "A-" }],
      ]),
    } as never);

    let activeRpcCalls = 0;
    let maxActiveRpcCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;

        if (url.includes("yields.llama.fi")) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  pool: "pool-lusd-aave",
                  chain: "Ethereum",
                  project: "aave-v3",
                  symbol: "LUSD",
                  tvlUsd: 12_000_000,
                  apy: 0.75,
                  apyBase: 0.75,
                  apyReward: null,
                  apyMean30d: 0.74,
                  stablecoin: true,
                  exposure: "single",
                  underlyingTokens: ["0x5f98805a4e8be255a32880fdec7f6728c6568ba0"],
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.includes("/simple/price?ids=liquity&vs_currencies=usd")) {
          return new Response(JSON.stringify({ liquity: { usd: 0.280527 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("rpc.example/eth")) {
          activeRpcCalls += 1;
          maxActiveRpcCalls = Math.max(maxActiveRpcCalls, activeRpcCalls);
          await Promise.resolve();
          try {
            const body = JSON.parse(String(init?.body)) as {
              params?: Array<{ data?: string } | string>;
            };
            const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;

            if (callData === "0x9bf2f1ac") {
              return new Response(
                JSON.stringify({
                  result: "0x0000000000000000000000000000000000000000000a88622849a78584de759b",
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }

            if (callData === "0xb140384b") {
              return new Response(
                JSON.stringify({
                  result: "0x0000000000000000000000000000000000000000001998cb5c5ea77bc8dc9000",
                }),
                { status: 200, headers: { "Content-Type": "application/json" } },
              );
            }
          } finally {
            activeRpcCalls -= 1;
          }
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/eth",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await fixtureSyncYieldData(db, undefined, testChainRpcs);

    expect(result.itemCount).toBe(2);
    expect(maxActiveRpcCalls).toBe(1);

    const bprotocolRow = findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "onchain:lusd-liquity");
    expect(bprotocolRow?.yield_source).toBe("B.Protocol Stability Pool (LQTY only)");
    expect(bprotocolRow?.yield_type).toBe("lending-vault");
    expect(bprotocolRow?.data_source).toBe("onchain");
    expect(Number(bprotocolRow?.current_apy)).toBeGreaterThan(1);
    expect(Number(bprotocolRow?.apy_reward)).toBeGreaterThan(1);
    expect(bprotocolRow?.is_best).toBe(1);

    const aaveRow = findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "pool-lusd-aave");
    expect(aaveRow?.yield_source).toBe("Aave V3");
    expect(aaveRow?.yield_type).toBe("lending-opportunity");
    expect(aaveRow?.data_source).toBe("defillama-auto");
    expect(aaveRow?.is_best).toBe(0);
  });

  it("handles DL yields API failure gracefully — no cached pools, API down", async () => {
    const db = makeDb();

    // No cached pools
    vi.mocked(fixtureGetCache).mockResolvedValue(null);

    // DL yields API returns 500
    fixtureMockFetch([{ match: "yields.llama.fi", body: { error: "Internal Server Error" }, status: 500 }]);

    const result = await fixtureSyncYieldData(db);

    // Should still return a result — just with no yield data resolved for DL-sourced coins
    // The function might resolve 0 if sDAI couldn't be matched (no DL pools available)
    expect(result.itemCount).toBeDefined();
    // recordOutcome should have been called with failure
    expect(fixtureRecordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-yields", false);
  });

  it("marks the run degraded when the direct DL yields fetch returns an invalid payload", async () => {
    const db = makeDb();

    vi.mocked(fixtureGetCache).mockResolvedValue(null);
    fixtureMockFetch([{ match: "yields.llama.fi", body: { nope: [] }, status: 200 }]);

    const result = await fixtureSyncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as { fallbackMode: string | null };
    expect(metadata.fallbackMode ?? "").toContain("dl-pools:direct-fetch-invalid-payload");
    expect(fixtureRecordOutcome).toHaveBeenCalledWith(expect.anything(), "defillama-yields", false);
  });

  it("skips DL yields fetch when circuit breaker is open", async () => {
    const db = makeDb();

    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);

    const fetchSpy = fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    // With no pools and circuit open, yield resolution falls through
    expect(result.itemCount).toBeDefined();
    // No DL yields fetch should have been attempted
    const yieldCalls = fetchSpy.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && (call[0] as string).includes("yields.llama.fi"),
    );
    expect(yieldCalls.length).toBe(0);
  });

  it("returns early with itemCount 0 when no yield-bearing coins exist", async () => {
    const originalYieldCoins = [...fixtureACTIVE_YIELD_BEARING_STABLECOINS];
    const db = makeDb();

    fixtureACTIVE_YIELD_BEARING_STABLECOINS.splice(0, fixtureACTIVE_YIELD_BEARING_STABLECOINS.length);

    try {
      const result = await fixtureSyncYieldData(db);

      expect(result.itemCount).toBe(0);
      expect(result.metadata).toBe("no yield-bearing coins");
      expect(fixtureShouldAttemptFetch).not.toHaveBeenCalled();
      expect(fixtureBatchExecute).not.toHaveBeenCalled();
    } finally {
      fixtureACTIVE_YIELD_BEARING_STABLECOINS.push(...originalYieldCoins);
    }
  });

  it("returns degraded when published yield-bearing coverage regresses against the previous rankings snapshot", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: JSON.stringify({
            rankings: Array.from({ length: 10 }, () => ({ id: "100" })),
          }),
          updatedAt: nowSec,
        };
      }
      return null;
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      previousPublishedYieldBearingCount: number;
      currentPublishedYieldBearingCount: number;
    };
    expect(metadata.reason).toBe("published-yield-coverage-regression");
    expect(metadata.previousPublishedYieldBearingCount).toBe(10);
    expect(metadata.currentPublishedYieldBearingCount).toBe(0);
    expect(fixtureBatchExecute).not.toHaveBeenCalled();
  });

  it("returns degraded when published lending-opportunity coverage regresses against the previous snapshot", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: JSON.stringify({
            rankings: [{ id: "100" }, ...Array.from({ length: 10 }, () => ({ id: "usdc-circle" }))],
          }),
          updatedAt: nowSec,
        };
      }
      return null;
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

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      previousPublishedOpportunityCount: number;
      currentPublishedOpportunityCount: number;
      previousPublishedRankingCount: number;
      currentPublishedRankingCount: number;
    };
    expect(metadata.reason).toBe("published-lending-opportunity-coverage-regression");
    expect(metadata.previousPublishedOpportunityCount).toBe(10);
    expect(metadata.currentPublishedOpportunityCount).toBe(0);
    expect(metadata.previousPublishedRankingCount).toBe(11);
    expect(metadata.currentPublishedRankingCount).toBe(1);
    expect(fixtureBatchExecute).not.toHaveBeenCalled();
  });

  it("returns degraded when total published ranking count regresses against the previous snapshot", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: JSON.stringify({
            rankings: Array.from({ length: 10 }, (_, index) => ({ id: `legacy-opportunity-${index}` })),
          }),
          updatedAt: nowSec,
        };
      }
      return null;
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

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      previousPublishedRankingCount: number;
      currentPublishedRankingCount: number;
    };
    expect(metadata.reason).toBe("published-total-coverage-regression");
    expect(metadata.previousPublishedRankingCount).toBe(10);
    expect(metadata.currentPublishedRankingCount).toBe(1);
    expect(fixtureBatchExecute).not.toHaveBeenCalled();
  });

  it("recovers a malformed previous yield-rankings cache when the new payload passes guards", async () => {
    const db = makeDb();
    const nowSec = Math.floor(Date.now() / 1000);

    vi.mocked(fixtureGetCache).mockImplementation(async (_db, key) => {
      if (key === "yield-rankings") {
        return {
          value: "{not-json",
          updatedAt: nowSec,
        };
      }
      return null;
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

    expect(result.itemCount).toBe(1);
    expect(getYieldRankingsCachePayload(db)).toBeDefined();
  });

  it("returns early when tracked yield coverage regresses below the guard threshold", async () => {
    const db = makeDb();
    const originalYieldCoins = [...fixtureACTIVE_YIELD_BEARING_STABLECOINS];

    for (let i = 0; i < 10; i++) {
      fixtureACTIVE_YIELD_BEARING_STABLECOINS.push({
        id: `yield-extra-${i}`,
        name: `Yield Extra ${i}`,
        symbol: `YE${i}`,
        geckoId: `yield-extra-${i}`,
        flags: {
          pegCurrency: "USD",
          backing: "crypto-backed",
          yieldBearing: true,
          navToken: false,
          governance: "decentralized",
        },
      } as never);
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

      const result = await fixtureSyncYieldData(db);
      const metadata = JSON.parse(result.metadata ?? "{}") as {
        reason?: string | null;
        coverage?: number;
        resolvedCount?: number;
        totalCount?: number;
      };

      expect(result.status).toBe("degraded");
      expect(metadata.reason).toBe("coverage-regression");
      expect(metadata.coverage).toBeCloseTo(1 / 11, 6);
      expect(metadata.resolvedCount).toBe(1);
      expect(metadata.totalCount).toBe(11);
      expect(fixtureBatchExecute).not.toHaveBeenCalled();
    } finally {
      fixtureACTIVE_YIELD_BEARING_STABLECOINS.splice(
        0,
        fixtureACTIVE_YIELD_BEARING_STABLECOINS.length,
        ...originalYieldCoins,
      );
    }
  });

  it("skips yield-rankings cache write when response payload fails schema validation", async () => {
    const db = makeBrokenYieldRankingsDb();
    vi.mocked(fixtureGetCache).mockResolvedValue(null);
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.spyOn(fixturePublicationModule, "validateYieldRankingsPayloadForPublish").mockResolvedValue({
      ok: false,
      validationFailures: 1,
      reason: "schema-validation-failed",
    });
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      publishFailure: string | null;
      validationFailures: number;
    };
    expect(metadata.reason).toBe("yield-rankings-preflight-failed");
    expect(metadata.publishFailure).toBe("schema-validation-failed");
    expect(metadata.validationFailures).toBe(1);
    expect(getYieldRankingsCachePayload(db)).toBeUndefined();
  });

  it("preserves published D1 rows when yield-rankings cache persistence fails before data replacement", async () => {
    const db = makeCacheWriteFailureDb(new Error("cache unavailable"));
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

    const result = await fixtureSyncYieldData(db);

    expect(result.status).toBe("degraded");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      reason: string | null;
      publishFailure: string | null;
    };
    expect(metadata.reason).toBe("yield-publication-transaction-failed");
    expect(metadata.publishFailure ?? "").toContain("cache unavailable");
    expect(fixtureWriteFreshnessSentinel).not.toHaveBeenCalled();
  });
});
