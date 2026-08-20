import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { mockRegistry } from "../../test-helpers/cron";

vi.mock("@shared/lib/stablecoins/registry", () => {
  const stablecoins = [
    {
      id: "susde-ethena",
      name: "sUSDe",
      symbol: "sUSDe",
      geckoId: "ethena-staked-usde",
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        yieldBearing: true,
        navToken: false,
        governance: "decentralized",
      },
      yieldConfig: {
        yieldSource: "Ethena staking",
        yieldType: "nav-appreciation",
      },
      contracts: [{ chain: "ethereum", address: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497", decimals: 18 }],
    },
    {
      id: "stusds-sky",
      name: "stUSDS",
      symbol: "stUSDS",
      geckoId: "staked-usds",
      flags: {
        pegCurrency: "USD",
        backing: "crypto-backed",
        yieldBearing: true,
        navToken: false,
        governance: "decentralized",
      },
      yieldConfig: {
        yieldSource: "Sky stUSDS Rate",
        yieldType: "lending-vault",
      },
      contracts: [{ chain: "ethereum", address: "0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9", decimals: 18 }],
    },
  ];
  return mockRegistry({
    stablecoins,
    trackedMetaById: new Map(stablecoins.map((coin) => [coin.id, coin])),
  });
});

vi.mock("../yield-config", () => ({
  YIELD_VARIANT_MAP: {},
  YIELD_POOL_MAP: {
    "susde-ethena": "pool-susde-native",
  },
  YIELD_WEIGHTED_POOL_GROUPS: {},
  EXPLICIT_YIELD_SOURCE_POOL_MAP: {},
  ON_CHAIN_RATE_CONFIGS: [
    {
      stablecoinId: "susde-ethena",
      chain: "ethereum",
      contract: "0x9D39A5DE30e57443BfF2A8307A4256c8797A3497",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
    },
    {
      stablecoinId: "stusds-sky",
      chain: "ethereum",
      contract: "0x99cd4ec3f88a45940936f469e4bb72a2a701eeb9",
      selector: "0x07a2d13a",
      decimals: 18,
      inputAmount: "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000",
      tvlRead: { kind: "erc4626-total-assets", decimals: 18 },
    },
  ],
  LENDING_PROTOCOL_ALLOWLIST: new Set(),
  LENDING_PROTOCOL_LABELS: {},
  PRICE_DERIVED_FALLBACK_IDS: new Set(),
  RATE_DERIVED_CONFIGS: [],
  AUTO_LENDING_POOL_MAP: {},
  AUTO_LENDING_SAFETY_BYPASS_IDS: new Set(),
  isAutoLendingCollisionBlockedForStablecoin: () => false,
}));

vi.mock("../yield-sync/tracked-optional-source-registry", () => ({
  TRACKED_OPTIONAL_SOURCE_REGISTRY_BY_ID: new Map(),
  STANDALONE_TRACKED_OPTIONAL_SOURCE_REGISTRY: [],
}));

vi.mock("../../lib/evm-rpc", () => ({
  fetchEvmUint256AtBlock: vi.fn(),
  fetchEtherscanUint256AtBlock: vi.fn(),
  fetchEvmCallHexAtBlock: vi.fn(),
}));

import { fetchEvmUint256AtBlock } from "../../lib/evm-rpc";
import { resolveTrackedYieldSources } from "../yield-sync/resolve-tracked-sources";
import { fetchOnChainRates } from "../yield-sync/sources-rpc";
import type { DlPool } from "../yield-sync/types";

const mockFetchEvmUint256AtBlock = vi.mocked(fetchEvmUint256AtBlock);

function makeDlPool(overrides: Partial<DlPool> & Pick<DlPool, "pool">): DlPool {
  return {
    pool: overrides.pool,
    chain: overrides.chain ?? "Ethereum",
    project: overrides.project ?? "ethena",
    symbol: overrides.symbol ?? "sUSDe",
    tvlUsd: overrides.tvlUsd ?? 0,
    apy: overrides.apy ?? 5,
    apyBase: overrides.apyBase ?? 5,
    apyReward: overrides.apyReward ?? null,
    apyMean30d: overrides.apyMean30d ?? 5,
    stablecoin: overrides.stablecoin ?? false,
    exposure: overrides.exposure ?? "single",
    underlyingTokens: overrides.underlyingTokens ?? null,
  };
}

function makeDb(prevExchangeRate = 1.0) {
  const nowSec = Math.floor(Date.now() / 1000);
  // loadTier1PrevRateRows binds recorded_at <= sevenDaysAgoSec.
  const recordedAt = nowSec - 8 * 86_400;
  return mockD1(
    [
      {
        match: "yield_history",
        rows: [
          {
            stablecoin_id: "susde-ethena",
            source_key: "onchain:susde-ethena",
            recorded_at: recordedAt,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: prevExchangeRate,
          },
          {
            stablecoin_id: "stusds-sky",
            source_key: "onchain:stusds-sky",
            recorded_at: recordedAt,
            is_best: 1,
            apy: 5,
            source_tvl_usd: null,
            data_source: "onchain",
            yield_source: null,
            yield_type: null,
            exchange_rate: prevExchangeRate,
          },
        ],
      },
      { match: "supply_history", rows: [] },
    ],
    { requireMatch: false },
  );
}

describe("on-chain measured TVL enrichment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("joins pinned DeFiLlama pool TVL onto on-chain rate candidates", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await resolveTrackedYieldSources({
      db: makeDb(),
      startSec: nowSec,
      sevenDaysAgoSec: nowSec - 7 * 86_400,
      dlPools: [makeDlPool({ pool: "pool-susde-native", tvlUsd: 3_500_000_000 })],
      onChainRates: new Map([["susde-ethena", { rate: 1.001 }]]),
      safetyScores: new Map(),
      riskFreeRates: {} as never,
    });

    const entry = result.resolved.find(
      (row) => row.id === "susde-ethena" && row.yield?.dataSource === "onchain",
    );
    expect(entry?.yield).toMatchObject({
      sourcePool: "pool-susde-native",
      sourceTvlUsd: 3_500_000_000,
      dataSource: "onchain",
    });
    expect(entry?.yield?.currentApy).toBeGreaterThan(0);
  });

  it("keeps sourceTvlUsd null when the pinned pool is missing from the DL snapshot", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await resolveTrackedYieldSources({
      db: makeDb(),
      startSec: nowSec,
      sevenDaysAgoSec: nowSec - 7 * 86_400,
      dlPools: [makeDlPool({ pool: "unrelated-pool", tvlUsd: 99_000_000 })],
      onChainRates: new Map([["susde-ethena", { rate: 1.001 }]]),
      safetyScores: new Map(),
      riskFreeRates: {} as never,
    });

    const entry = result.resolved.find(
      (row) => row.id === "susde-ethena" && row.yield?.dataSource === "onchain",
    );
    expect(entry?.yield).toMatchObject({
      sourcePool: "pool-susde-native",
      sourceTvlUsd: null,
      dataSource: "onchain",
    });
  });

  it("prefers DL-joined TVL over on-chain tvlRead residual", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await resolveTrackedYieldSources({
      db: makeDb(),
      startSec: nowSec,
      sevenDaysAgoSec: nowSec - 7 * 86_400,
      dlPools: [makeDlPool({ pool: "pool-susde-native", tvlUsd: 1_234_567 })],
      onChainRates: new Map([["susde-ethena", { rate: 1.001, sourceTvlUsd: 999 }]]),
      safetyScores: new Map(),
      riskFreeRates: {} as never,
    });

    const entry = result.resolved.find(
      (row) => row.id === "susde-ethena" && row.yield?.dataSource === "onchain",
    );
    expect(entry?.yield?.sourceTvlUsd).toBe(1_234_567);
  });

  it("uses on-chain tvlRead residual when no pinned DL pool is available", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const result = await resolveTrackedYieldSources({
      db: makeDb(),
      startSec: nowSec,
      sevenDaysAgoSec: nowSec - 7 * 86_400,
      dlPools: [],
      onChainRates: new Map([["stusds-sky", { rate: 1.001, sourceTvlUsd: 88_000_000 }]]),
      safetyScores: new Map(),
      riskFreeRates: {} as never,
    });

    const entry = result.resolved.find(
      (row) => row.id === "stusds-sky" && row.yield?.dataSource === "onchain",
    );
    expect(entry?.yield).toMatchObject({
      sourcePool: null,
      sourceTvlUsd: 88_000_000,
      dataSource: "onchain",
    });
  });
});

describe("fetchOnChainRates optional ERC-4626 tvlRead", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeChainRpcs(): Map<string, ChainRpcConfig> {
    return new Map([
      [
        "ethereum",
        {
          chainId: "ethereum",
          chainName: "Ethereum",
          type: "evm",
          rpcUrl: "https://rpc.ethereum.example.com",
          explorerUrl: "https://etherscan.io",
        },
      ],
    ]);
  }

  it("fails open to null sourceTvlUsd when totalAssets read errors", async () => {
    mockFetchEvmUint256AtBlock.mockImplementation(async (_chain, _to, data) => {
      // convertToAssets rate call succeeds; totalAssets fails closed to null.
      if (data === "0x01e1d114") return null;
      return 1_050_000_000_000_000_000n;
    });

    const result = await fetchOnChainRates(undefined, makeChainRpcs());
    const stusds = result.rates.get("stusds-sky");
    expect(stusds?.rate).toBeCloseTo(1.05, 6);
    expect(stusds?.sourceTvlUsd ?? null).toBeNull();
  });

  it("populates sourceTvlUsd from totalAssets for configured residual vaults", async () => {
    mockFetchEvmUint256AtBlock.mockImplementation(async (_chain, _to, data) => {
      if (data === "0x01e1d114") return 250_000_000_000_000_000_000_000_000n; // 250M @ 18 decimals
      return 1_020_000_000_000_000_000n;
    });

    const result = await fetchOnChainRates(undefined, makeChainRpcs());
    const stusds = result.rates.get("stusds-sky");
    expect(stusds?.rate).toBeCloseTo(1.02, 6);
    expect(stusds?.sourceTvlUsd).toBeCloseTo(250_000_000, 0);
  });
});
