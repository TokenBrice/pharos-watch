import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findPublishedYieldRow,
  getYieldRankingsCachePayload,
  mockHealthyRiskFreeRateCache,
  resetSyncYieldDataTest,
  cleanupSyncYieldDataTest,
  fixtureMockD1 as createFixtureMockD1,
  fixtureSyncYieldData,
  fixtureGetCache,
  fixtureShouldAttemptFetch,
  fixtureGetChainRpc,
  fixtureMockFetch,
  fixtureYieldConfigModule,
  fixtureEvmRpcModule,
  type ChainRpcConfig,
} from "./sync-yield-data.test-support";
import { cacheRow, installYieldCacheReader } from "./yield-cache.test-support";
import { makeDlYieldPool } from "./yield-resolve.test-support";

function fixtureMockD1(tables: Parameters<typeof createFixtureMockD1>[0] = []) {
  return createFixtureMockD1([
    ...tables,
    { match: "ranked_linked_generations", rows: [] },
    { match: "pharos:yield-sync:decision-retention-delete", rows: [] },
    { match: "pharos:yield-sync:decision-alternatives-retention-delete", rows: [] },
    { match: "source_switch = 0", rows: [] },
  ]);
}

function makeDb() {
  return createFixtureMockD1([
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
  it("tries price-derived as additional source when DL returns 0% APY for navToken", async () => {
    // sDAI (navToken: true) gets a DL pool with 0% APY.
    // The resolve logic should also try price-derived and pick the non-zero source.
    const nowSec = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      {
        match:
          "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
        matchBinds: ["100"],
        rows: [],
        first: { price: 1.05, snapshot_date: nowSec },
      },
      {
        match: "FROM supply_history",
        matchBinds: ["100", nowSec - 45 * 86400, nowSec - 7 * 86400],
        rows: [],
        first: { price: 1.01, snapshot_date: nowSec - 30 * 86400 },
      },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      "dl-stablecoin-pools": cacheRow([
            makeDlYieldPool({
              pool: "pool-sdai-zero",
              tvlUsd: 500_000_000,
              apy: 0,
              apyBase: 0,
              apyMean30d: 0,
            }),
      ], Math.floor(Date.now() / 1000)),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    // Two source rows: DL (0% APY) + price-derived (4.0% from mock)
    expect(result.itemCount).toBe(2);

    const priceDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "price-derived");
    expect(priceDerivedRow).toBeDefined();
    // price-derived APY should be > 0 (computeApyFromPrice mock returns 4.0)
    expect(Number(priceDerivedRow?.current_apy)).toBeGreaterThan(0);
    // data_source should be "price-derived"
    expect(priceDerivedRow?.data_source).toBe("price-derived");
    // price-derived should be is_best (higher APY than DL's 0%)
    expect(priceDerivedRow?.is_best).toBe(1);

    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      rankings: Array<{
        id: string;
        provenance?: {
          sourceObservedAt: number;
          sourceAgeSeconds: number;
          comparisonAnchorObservedAt?: number | null;
          comparisonAnchorAgeSeconds?: number | null;
        } | null;
      }>;
    };
    const ranking = rankingsPayload.rankings.find((entry) => entry.id === "100");
    expect(ranking?.provenance?.sourceObservedAt).toBe(nowSec);
    expect(ranking?.provenance?.sourceAgeSeconds).toBe(0);
    expect(ranking?.provenance?.comparisonAnchorObservedAt).toBe(nowSec - 30 * 86400);
    expect(ranking?.provenance?.comparisonAnchorAgeSeconds).toBe(30 * 86400);
  });

  it("uses the oldest available 7-45 day price anchor for young navToken coverage", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      {
        match:
          "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
        matchBinds: ["100"],
        rows: [],
        first: { price: 1.05, snapshot_date: nowSec },
      },
      {
        match: "FROM supply_history",
        matchBinds: ["100", nowSec - 45 * 86400, nowSec - 7 * 86400],
        rows: [],
        first: { price: 1.01, snapshot_date: nowSec - 10 * 86400 },
      },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      "dl-stablecoin-pools": cacheRow([], nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const priceDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "price-derived");
    expect(priceDerivedRow).toBeDefined();
    expect(Number(priceDerivedRow?.current_apy)).toBeGreaterThan(0);
  });

  it("computes trailing APY from source-specific history instead of mixed coin-level history", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "AND recorded_at <= ? AND exchange_rate IS NOT NULL",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 8 * 86400,
            exchange_rate: 1.0,
          },
        ],
      },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "price-derived",
            recorded_at: nowSec - 2 * 86400,
            is_best: 1,
            apy: 2,
            source_tvl_usd: null,
            data_source: "price-derived",
            yield_source: null,
            yield_type: null,
          },
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-zero",
            recorded_at: nowSec - 2 * 86400,
            is_best: 0,
            apy: 9,
            source_tvl_usd: 500_000_000,
            data_source: "defillama",
            yield_source: "DSR",
            yield_type: "nav-appreciation",
          },
        ],
      },
      {
        match:
          "SELECT price, snapshot_date FROM supply_history WHERE stablecoin_id = ? AND price IS NOT NULL ORDER BY snapshot_date DESC LIMIT 1",
        matchBinds: ["100"],
        rows: [],
        first: { price: 1.05, snapshot_date: nowSec },
      },
      {
        match: "FROM supply_history",
        matchBinds: ["100", nowSec - 45 * 86400, nowSec - 7 * 86400],
        rows: [],
        first: { price: 1.01, snapshot_date: nowSec - 30 * 86400 },
      },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      "dl-stablecoin-pools": cacheRow([
            makeDlYieldPool({
              pool: "pool-sdai-zero",
              tvlUsd: 500_000_000,
              apy: 0,
              apyBase: 0,
              apyMean30d: 0,
            }),
      ], nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const priceDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "price-derived");

    // Source-specific history should average [2, 4] => 3.0 instead of mixing in the DL row's 9% sample.
    expect(Number(priceDerivedRow?.apy_30d)).toBeCloseTo(3, 3);
  });

  it("does not carry forward legacy history when the current source family changed", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const configs =
      fixtureYieldConfigModule.RATE_DERIVED_CONFIGS as typeof fixtureYieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({ stablecoinId: "100", spreadBps: 25, label: "T-bill proxy (net of 0.25% fee)" });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "legacy-best",
            recorded_at: nowSec - 2 * 86400,
            is_best: 1,
            apy: 0,
            source_tvl_usd: null,
            data_source: "price-derived",
            yield_source: null,
            yield_type: null,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    await fixtureSyncYieldData(db);

    const rateDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "rate-derived");

    // The current row should stand on its own source-specific history rather than averaging with legacy price-derived rows.
    expect(Number(rateDerivedRow?.apy_30d)).toBeCloseTo(3.75, 3);

    configs.length = 0;
  });

  it("resolves rate-derived yield from cached T-bill rate for configured tokens", async () => {
    // Temporarily inject a rate-derived config for sDAI (id "100")
    const configs =
      fixtureYieldConfigModule.RATE_DERIVED_CONFIGS as typeof fixtureYieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({ stablecoinId: "100", spreadBps: 25, label: "T-bill proxy (net of 0.25% fee)" });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    // Return a risk_free_rate of 4.0% from cache
    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", Math.floor(Date.now() / 1000)),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    // Should have at least one row written for rate-derived
    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const rateDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "rate-derived");
    expect(rateDerivedRow).toBeDefined();
    // APY should be 4.0 - 0.25 = 3.75
    expect(Number(rateDerivedRow?.current_apy)).toBeCloseTo(3.75, 2);
    // data_source should be "rate-derived"
    expect(rateDerivedRow?.data_source).toBe("rate-derived");
    // rate-derived should be is_best (only source)
    expect(rateDerivedRow?.is_best).toBe(1);

    // Clean up
    configs.length = 0;
  });

  it("resolves OUSG rate-derived yield with 50bps spread", async () => {
    const configs =
      fixtureYieldConfigModule.RATE_DERIVED_CONFIGS as typeof fixtureYieldConfigModule.RATE_DERIVED_CONFIGS;
    configs.push({ stablecoinId: "100", spreadBps: 50, label: "T-bill proxy (net of 0.50% fee)" });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      { match: "yield_history", rows: [] },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.25", Math.floor(Date.now() / 1000)),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);

    expect(result.itemCount).toBeGreaterThanOrEqual(1);

    const rateDerivedRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "rate-derived");
    expect(rateDerivedRow).toBeDefined();
    // APY should be 4.25 - 0.50 = 3.75
    expect(Number(rateDerivedRow?.current_apy)).toBeCloseTo(3.75, 2);
    expect(rateDerivedRow?.data_source).toBe("rate-derived");

    configs.length = 0;
  });

  it("produces valid APY entry from expanded ON_CHAIN_RATE_CONFIGS", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", Math.floor(Date.now() / 1000)),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);

    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    // Mock fetch to handle the convertToAssets RPC call
    fixtureMockFetch([{ match: () => true, respond: async (request) => {
        const url = request.url;
        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(await request.clone().text()) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            // Return exchange rate of ~1.05e18 (5% appreciation)
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    }]);

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
    await fixtureSyncYieldData(db, undefined, testChainRpcs);

    const onChainRow = findPublishedYieldRow(db, "100", (row) => row.data_source === "onchain");
    expect(onChainRow).toBeDefined();
    expect(Number(onChainRow?.current_apy)).toBeGreaterThan(0);

    const rankingsPayload = getYieldRankingsCachePayload(db) as {
      rankings: Array<{
        id: string;
        provenance?: {
          sourceObservedAt: number;
          sourceAgeSeconds: number;
          comparisonAnchorObservedAt?: number | null;
          comparisonAnchorAgeSeconds?: number | null;
        } | null;
      }>;
    };
    const ranking = rankingsPayload.rankings.find((entry) => entry.id === "100");
    expect(ranking?.provenance?.sourceObservedAt).toBe(nowSec);
    expect(ranking?.provenance?.sourceAgeSeconds).toBe(0);
    expect(ranking?.provenance?.comparisonAnchorObservedAt).toBe(nowSec - 8 * 86400);
    expect(ranking?.provenance?.comparisonAnchorAgeSeconds).toBe(8 * 86400);

    onChainConfigs.length = 0;
  });

  it("marks the run degraded when all deterministic on-chain sources fail", async () => {
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = makeDb();
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    fixtureMockFetch([]);

    const result = await fixtureSyncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainAttempted?: number;
        onChainAllDeterministicFailed?: boolean;
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode ?? "").toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(true);
    expect(metadata.sourceCoverage?.onChainFailures).toEqual({ "no-chain-rpcs": 1 });

    onChainConfigs.length = 0;
  });

  it("keeps the run healthy when deterministic on-chain reads fail but every affected coin has non-onchain coverage", async () => {
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = makeDb();
    mockHealthyRiskFreeRateCache();
    fixtureMockFetch([
      {
        match: "yields.llama.fi",
        body: {
          data: [
            makeDlYieldPool({
              pool: "pool-sdai-1",
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyMean30d: 5.1,
            }),
          ],
        },
      },
    ]);

    const result = await fixtureSyncYieldData(db);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainAllDeterministicFailed?: boolean;
        onChainFailureMaskedByAlternativeCoverage?: boolean;
        onChainAlternativeCoverageMissingIds?: string[];
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(result.status).toBeUndefined();
    expect(metadata.fallbackMode).toBeNull();
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(true);
    expect(metadata.sourceCoverage?.onChainFailureMaskedByAlternativeCoverage).toBe(true);
    expect(metadata.sourceCoverage?.onChainAlternativeCoverageMissingIds).toEqual([]);
    expect(metadata.sourceCoverage?.onChainFailures).toEqual({ "no-chain-rpcs": 1 });

    onChainConfigs.length = 0;
  });

  it("falls back to the secondary RPC URL before degrading the deterministic lane", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/primary",
      fallbackRpcUrl: "https://rpc.example/fallback",
      explorerUrl: "https://etherscan.io",
    });

    fixtureMockFetch([{ match: () => true, respond: async (request) => {
        const url = request.url;
        if (url.includes("rpc.example/fallback")) {
          const body = JSON.parse(await request.clone().text()) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }

        if (url.includes("rpc.example/primary")) {
          return new Response(
            JSON.stringify({
              error: { message: "upstream unhealthy" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    }]);

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/primary",
          fallbackRpcUrl: "https://rpc.example/fallback",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await fixtureSyncYieldData(db, undefined, testChainRpcs);
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainRatesResolved?: number;
        onChainAllDeterministicFailed?: boolean;
      };
    };

    expect(metadata.fallbackMode ?? "").not.toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainRatesResolved).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(false);

    onChainConfigs.length = 0;
  });

  it("falls back to the Etherscan proxy when Worker RPC reads all fail", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/primary",
      fallbackRpcUrl: "https://rpc.example/fallback",
      explorerUrl: "https://etherscan.io",
    });
    fixtureMockFetch([]);
    const rawRpcSpy = vi.spyOn(fixtureEvmRpcModule, "fetchEvmUint256AtBlock").mockResolvedValue(null);
    const etherscanSpy = vi
      .spyOn(fixtureEvmRpcModule, "fetchEtherscanUint256AtBlock")
      .mockResolvedValue(BigInt("1050000000000000000"));

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/primary",
          fallbackRpcUrl: "https://rpc.example/fallback",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await fixtureSyncYieldData(db, undefined, testChainRpcs, undefined, "etherscan-key");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainRatesResolved?: number;
        onChainAllDeterministicFailed?: boolean;
        onChainExplorerAttempted?: number;
        onChainExplorerResolved?: number;
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(metadata.fallbackMode ?? "").not.toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainRatesResolved).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(false);
    expect(metadata.sourceCoverage?.onChainExplorerAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainExplorerResolved).toBe(1);
    expect(metadata.sourceCoverage?.onChainFailures).toBeNull();
    const deterministicRawRpcCalls = rawRpcSpy.mock.calls.filter(
      ([, contract, data]) =>
        contract === "0x83F20F44975D03b1b09e64809B757c47f942BEeA" &&
        typeof data === "string" &&
        data.startsWith("0x07a2d13a"),
    );
    expect(deterministicRawRpcCalls).toHaveLength(2);
    expect(etherscanSpy).toHaveBeenCalledWith(
      1,
      "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      expect.stringMatching(/^0x07a2d13a/),
      "latest",
      expect.objectContaining({ apiKey: "etherscan-key" }),
    );

    onChainConfigs.length = 0;
  });

  it("records explorer fallback failures when deterministic RPC and explorer reads both return empty", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/primary",
      fallbackRpcUrl: "https://rpc.example/fallback",
      explorerUrl: "https://etherscan.io",
    });
    fixtureMockFetch([]);
    vi.spyOn(fixtureEvmRpcModule, "fetchEvmUint256AtBlock").mockResolvedValue(null);
    vi.spyOn(fixtureEvmRpcModule, "fetchEtherscanUint256AtBlock").mockResolvedValue(null);

    const testChainRpcs = new Map<string, ChainRpcConfig>([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.example/primary",
          fallbackRpcUrl: "https://rpc.example/fallback",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
    const result = await fixtureSyncYieldData(db, undefined, testChainRpcs, undefined, "etherscan-key");
    const metadata = JSON.parse(result.metadata ?? "{}") as {
      fallbackMode?: string | null;
      sourceCoverage?: {
        onChainAttempted?: number;
        onChainAllDeterministicFailed?: boolean;
        onChainExplorerAttempted?: number;
        onChainExplorerResolved?: number;
        onChainFailures?: Record<string, number> | null;
      };
    };

    expect(result.status).toBe("degraded");
    expect(metadata.fallbackMode ?? "").toContain("onchain-rates:all-deterministic-failed");
    expect(metadata.sourceCoverage?.onChainAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainAllDeterministicFailed).toBe(true);
    expect(metadata.sourceCoverage?.onChainExplorerAttempted).toBe(1);
    expect(metadata.sourceCoverage?.onChainExplorerResolved).toBe(0);
    expect(metadata.sourceCoverage?.onChainFailures).toEqual({ "rpc-empty|etherscan-empty": 1 });

    onChainConfigs.length = 0;
  });

  it("reuses legacy rate history without aliasing its source identity", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 9,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    fixtureMockFetch([{ match: () => true, respond: async (request) => {
        const url = request.url;
        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(await request.clone().text()) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    }]);

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

    const onChainRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "onchain:100");
    expect(onChainRow).toBeDefined();
    expect(Number(onChainRow?.apy_7d)).toBeCloseTo(5, 6);
    expect(Number(onChainRow?.apy_30d)).toBeCloseTo(7, 6);
    expect(onChainRow?.exchange_rate_prev).toBe(1.0);

    const metadata = JSON.parse(result.metadata ?? "{}") as { sourceSwitches?: number };
    expect(metadata.sourceSwitches).toBe(1);
  });

  it("reuses legacy B.Protocol history after normalizing the LUSD deterministic source key", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "lusd-liquity",
            source_key: "bprotocol-lqty-only",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 4.5,
            source_tvl_usd: 1_250_000,
            data_source: "onchain",
            yield_source: "B.Protocol Stability Pool (LQTY only)",
            yield_type: "lending-vault",
            exchange_rate: null,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      risk_free_rate: cacheRow("4.0", nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    fixtureMockFetch([{ match: () => true, respond: async (request) => {
        const url = request.url;

        if (url.includes("/simple/price?ids=liquity&vs_currencies=usd")) {
          return new Response(JSON.stringify({ liquity: { usd: 0.280527 } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(await request.clone().text()) as {
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
        }

        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    }]);

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

    const onChainRow = findPublishedYieldRow(db, "lusd-liquity", (row) => row.source_key === "onchain:lusd-liquity");
    expect(onChainRow).toBeDefined();
    expect(onChainRow?.is_best).toBe(1);

    const metadata = JSON.parse(result.metadata ?? "{}") as { sourceSwitches?: number };
    expect(metadata.sourceSwitches).toBe(0);
  });

  it("retains both on-chain and curated rows when the native pool overlaps with ON_CHAIN_RATE_CONFIGS", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const onChainConfigs =
      fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS as typeof fixtureYieldConfigModule.ON_CHAIN_RATE_CONFIGS;
    const poolMap = fixtureYieldConfigModule.YIELD_POOL_MAP as Record<string, string>;
    onChainConfigs.push({
      stablecoinId: "100",
      chain: "ethereum",
      contract: "0x83F20F44975D03b1b09e64809B757c47f942BEeA",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    });
    poolMap["100"] = "pool-sdai-native";

    const db = fixtureMockD1([
      { match: "cache", rows: [] },
      { match: "yield_data", rows: [] },
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "100",
            source_key: "onchain:100",
            recorded_at: nowSec - 8 * 86400,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: 1.0,
          },
          {
            stablecoin_id: "100",
            source_key: "pool-sdai-native",
            recorded_at: nowSec - 7 * 86400 + 3600,
            is_best: 1,
            apy: 5.2,
            source_tvl_usd: 1_000_000_000,
            data_source: "defillama",
            yield_source: "DSR",
            yield_type: "nav-appreciation",
            exchange_rate: null,
          },
        ],
      },
      { match: "supply_history", rows: [] },
      { match: "depeg_events", rows: [] },
      { match: "dex_liquidity", rows: [] },
    ]);

    installYieldCacheReader(vi.mocked(fixtureGetCache), {
      "dl-stablecoin-pools": cacheRow([
            makeDlYieldPool({
              tvlUsd: 1_000_000_000,
              apy: 5.2,
              apyBase: 5.2,
              apyMean30d: 5.1,
            }),
      ], nowSec - 60),
      risk_free_rate: cacheRow("4.0", nowSec),
    });
    vi.mocked(fixtureShouldAttemptFetch).mockResolvedValue(false);
    vi.mocked(fixtureGetChainRpc).mockReturnValue({
      chainId: "ethereum",
      chainName: "Ethereum",
      type: "evm",
      rpcUrl: "https://rpc.example/eth",
      explorerUrl: "https://etherscan.io",
    });

    fixtureMockFetch([{ match: () => true, respond: async (request) => {
        const url = request.url;
        if (url.includes("rpc.example/eth")) {
          const body = JSON.parse(await request.clone().text()) as {
            params?: Array<{ data?: string } | string>;
          };
          const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
          if (callData?.startsWith("0x07a2d13a")) {
            return new Response(
              JSON.stringify({
                result: "0x" + BigInt("1050000000000000000").toString(16).padStart(64, "0"),
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            );
          }
        }
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      },
    }]);

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
    await fixtureSyncYieldData(db, undefined, testChainRpcs);

    const onChainRow = findPublishedYieldRow(db, "100", (row) => row.source_key === "onchain:100");
    const curatedRow = findPublishedYieldRow(
      db,
      "100",
      (row) => row.source_key === "pool-sdai-native" && row.data_source === "defillama",
    );
    expect(onChainRow).toBeDefined();
    expect(curatedRow).toBeDefined();
    expect(Number(onChainRow?.current_apy)).toBeGreaterThan(0);

    delete poolMap["100"];
    onChainConfigs.length = 0;
  });
});
