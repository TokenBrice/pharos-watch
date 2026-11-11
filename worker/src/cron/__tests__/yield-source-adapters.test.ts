import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { makeChainRpcConfig } from "../../test-helpers/chain-rpc-fixtures.test-support";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", async (importOriginal) => ({
  ...mockYieldSourceFetchRetryModule(),
  // Pendle reads the response cap directly instead of going through a retry
  // reader, so a factory that omits it makes every parsed page throw RangeError.
  DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES:
    (await importOriginal<typeof import("../../lib/fetch-retry")>()).DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES,
}));

import { RATE_DERIVED_CONFIGS } from "../../lib/yield-config/yield-config-rate-sources";
import { fetchZephyrZysSource } from "../../lib/yield-source-adapters/zephyr";
import { BASEDOLLAR_SP_CONFIG, LIQUITY_V2_SP_CONFIG, fetchCurveScrvusdCurrentRateSource, fetchLiquityV2StabilityPoolSource, type LiquityV2SpSourceConfig } from "../yield-sync/sources-optional-onchain";
import { fetchBeefySources, fetchMorphoVaultSources, fetchPendleMarketSources, fetchYearnKongSources, fetchYearnYboldSource } from "../yield-sync/sources-optional-vaults";
import { fetchHashnoteUsycSource, fetchReProtocolReusdSource } from "../yield-sync/sources-optional-nav";

const mockMorpho = (items: unknown[]) => mockYieldSourceRoutes([{ match: "api.morpho.org", body: { data: { vaults: { items } } } }]);

const morphoVault = (overrides: Record<string, unknown> = {}) => ({
  address: "0x9eF4cb75FeD5b3913219E881E0FF0b10a6761CF3",
  name: "Gauntlet USDC Prime",
  asset: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
  chain: { id: 1 },
  state: { netApy: 0.03, totalAssetsUsd: 1_000_000, fee: 0 },
  ...overrides,
});

const pendleMarket = (overrides: Record<string, unknown> = {}) => ({
  id: "1-0xabc",
  address: "0xAbC",
  chainId: 1,
  isActive: true,
  expiry: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
  impliedApy: 0.052,
  underlyingApy: 0.031,
  aggregatedApy: 0.052,
  underlyingAsset: { symbol: "USDG", address: "0xdef" },
  assetRepresentation: "USDG",
  protocol: "Global Dollar",
  liquidity: { usd: 82_000_000 },
  categoryIds: ["stables"],
  ...overrides,
});

const kongVault = (overrides: Record<string, unknown> = {}) => ({
  address: "0xabc",
  name: "USDC yVault",
  yearn: true,
  asset: { symbol: "USDC" },
  tvl: { close: 50_000_000 },
  apy: { net: 0.03, monthlyNet: 0.03 },
  meta: { category: "Stablecoin", isRetired: false },
  ...overrides,
});

describe("fetchBeefySources", () => {
  afterEach(cleanupYieldSourceTest);

  it("joins APY and vault metadata for stablecoin single-asset vaults", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_121_600_000);
    mockYieldSourceRoutes([
      { match: "api.beefy.finance/apy", body: { "Aave-USDC": 0.037 } },
      { match: "api.beefy.finance/tvl", body: { "43114": { "Aave-USDC": 12_500_000 } } },
      {
        match: "api.beefy.finance/vaults",
        body: [
          {
            id: "Aave-USDC",
            name: "Aave USDC",
            token: "USDC",
            assets: ["USDC"],
            status: "active",
            chain: "avax",
            platformId: "aave",
            tokenAddress: "0x123",
            earnContractAddress: "0x456",
            earnedToken: "mooAaveUSDC",
            earnedTokenAddress: "0x789",
            oracle: "tokens",
            oracleId: "USDC",
          },
        ],
      },
    ]);

    const { candidates: results } = await fetchBeefySources();
    expect(results).toStrictEqual([{
      symbol: "USDC", chain: "avalanche", address: "0x123",
      yield: {
        currentApy: 3.6999999999999997, apyBase: 3.6999999999999997, apyReward: null,
        sourcePool: "Aave-USDC", sourceTvlUsd: 12_500_000, dataSource: "protocol-api",
        exchangeRate: null, sourceKey: "protocol-api:beefy:avalanche:Aave-USDC",
        yieldSource: "Beefy: Aave USDC", yieldType: "lending-opportunity",
        sourceObservedAt: 1_790_121_600, comparisonAnchorObservedAt: null,
      },
    }]);
  });

  it.each([
    {
      name: "skips EOL vaults",
      apy: { "old-usdc": 0.05 },
      tvl: { "1": { "old-usdc": 1_000_000 } },
      vault: {
        id: "old-usdc",
        name: "Old USDC",
        token: "USDC",
        assets: ["USDC"],
        status: "eol",
        chain: "ethereum",
        platformId: "aave",
        tokenAddress: "0x1",
        earnContractAddress: "0x2",
        earnedToken: "moo",
        earnedTokenAddress: "0x3",
        oracle: "tokens",
        oracleId: "USDC",
      },
    },
    {
      name: "skips multi-asset LP vaults",
      apy: { "curve-usdc-usdt": 0.06 },
      tvl: { "1": { "curve-usdc-usdt": 1_000_000 } },
      vault: {
        id: "curve-usdc-usdt",
        name: "Curve USDC-USDT",
        token: "crvUSDC-USDT",
        assets: ["USDC", "USDT"],
        status: "active",
        chain: "ethereum",
        platformId: "curve",
        tokenAddress: "0x1",
        earnContractAddress: "0x2",
        earnedToken: "moo",
        earnedTokenAddress: "0x3",
        oracle: "lps",
        oracleId: "curve-usdc-usdt",
      },
    },
    {
      name: "skips vaults without enough Beefy TVL to pass size gates",
      apy: { "aave-usdc": 0.037 },
      tvl: { "1": { "aave-usdc": 99_999 } },
      vault: {
        id: "aave-usdc",
        name: "Aave USDC",
        token: "USDC",
        assets: ["USDC"],
        status: "active",
        chain: "ethereum",
        platformId: "aave",
        tokenAddress: "0x123",
      },
    },
  ])("$name", async ({ apy, tvl, vault }) => {
    mockYieldSourceRoutes([
      { match: "api.beefy.finance/apy", body: apy },
      { match: "api.beefy.finance/tvl", body: tvl },
      { match: "api.beefy.finance/vaults", body: [vault] },
    ]);
    await expect(fetchBeefySources()).resolves.toEqual({ candidates: [], degraded: false });
  });

  it("marks the family degraded when an upstream document is unreadable", async () => {
    mockYieldSourceRoutes([{ match: "api.beefy.finance/apy", status: 500, body: {} }]);

    expect(await fetchBeefySources()).toEqual({ candidates: [], degraded: true });
  });
});

describe("fetchHashnoteUsycSource", () => {
  afterEach(() => {
    vi.useRealTimers();
    cleanupYieldSourceTest();
  });

  it("derives APY from USYC price reports", async () => {
    const nowSec = 1_780_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    const sevenDaysAgoSec = nowSec - 7 * 86400;
    mockYieldSourceRoutes([
      {
        match: "usyc.hashnote.com/api/price-reports",
        body: {
          entity: "usyc_price_report",
          data: [
            {
              roundId: "392",
              price: "1.120246648414663082",
              timestamp: String(nowSec),
              principal: "2453604554.64",
              interest: "236175.55",
              balance: "2453840730.19",
              totalSupply: "2190425756.78094",
              decimals: 6,
              fee: "21082.459861",
              txhash: "0xabc",
            },
            {
              roundId: "385",
              price: "1.119046648414663082",
              timestamp: String(sevenDaysAgoSec),
              principal: "2400000000.00",
              interest: "200000.00",
              balance: "2400200000.00",
              totalSupply: "2190000000.00",
              decimals: 6,
              fee: "20000.00",
              txhash: "0xdef",
            },
          ],
        },
      },
    ]);

    const result = await fetchHashnoteUsycSource();
    expect(result).toEqual(
      expect.objectContaining({
        dataSource: "protocol-api",
        sourceKey: "protocol-api:hashnote-usyc",
        yieldSource: "Hashnote USYC",
      }),
    );
    expect(result!.currentApy).toBeCloseTo(5.7517, 4);
    expect(result!.comparisonAnchorObservedAt).toBe(sevenDaysAgoSec);
  });

  it("retains a finite negative holder return from declining USYC NAV reports", async () => {
    const nowSec = 1_780_000_000;
    const anchor = nowSec - 7 * 86400;
    vi.useFakeTimers();
    vi.setSystemTime(nowSec * 1000);
    mockYieldSourceRoutes([{
      match: "usyc.hashnote.com/api/price-reports",
      body: { data: [
        { price: "0.99", timestamp: String(nowSec) },
        { price: "1", timestamp: String(anchor) },
      ] },
    }]);
    const result = await fetchHashnoteUsycSource();
    expect(result?.currentApy).toBeCloseTo((Math.pow(0.99, 365.25 / 7) - 1) * 100);
    expect(result?.apyBase).toBe(result?.currentApy);
    expect(result).toMatchObject({ sourceObservedAt: nowSec, comparisonAnchorObservedAt: anchor });
  });

  it.each([301, 6 * 86400])("quarantines a newest USYC report %s seconds beyond now", async (futureSec) => {
    const nowSec = 1_780_000_000;
    vi.useFakeTimers().setSystemTime(nowSec * 1000);
    mockYieldSourceRoutes([{ match: "usyc.hashnote.com/api/price-reports", body: { data: [
      { price: "1.002", timestamp: String(nowSec + futureSec) },
      { price: "1", timestamp: String(nowSec - 86400) },
    ] } }]);
    await expect(fetchHashnoteUsycSource()).resolves.toBeNull();
  });

  it("never uses a future anchor and admits the inclusive five-minute latest boundary", async () => {
    const nowSec = 1_780_000_000;
    const latest = nowSec + 300;
    const anchor = latest - 7 * 86400;
    vi.useFakeTimers().setSystemTime(nowSec * 1000);
    mockYieldSourceRoutes([{ match: "usyc.hashnote.com/api/price-reports", body: { data: [
      { price: "1.9", timestamp: String(nowSec + 6 * 86400) },
      { price: "1.002", timestamp: String(latest) },
      { price: "1", timestamp: String(anchor) },
    ] } }]);
    const result = await fetchHashnoteUsycSource();
    expect(result).toMatchObject({ sourceObservedAt: latest, comparisonAnchorObservedAt: anchor });
    expect(result?.currentApy).toBeCloseTo((Math.pow(1.002, 365.25 / 7) - 1) * 100);
  });

  it("returns null on HTTP error", async () => {
    mockYieldSourceRoutes([{ match: "usyc.hashnote.com", status: 500, body: "" }]);
    await expect(fetchHashnoteUsycSource()).resolves.toBeNull();
  });

  it("returns null when the latest report is stale", async () => {
    const staleNowSec = 1_780_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(staleNowSec * 1000);
    mockYieldSourceRoutes([
      {
        match: "usyc.hashnote.com/api/price-reports",
        body: {
          entity: "usyc_price_report",
          data: [
            { roundId: "100", price: "1.12", timestamp: String(staleNowSec - 4 * 86400) },
            { roundId: "99", price: "1.11", timestamp: String(staleNowSec - 11 * 86400) },
          ],
        },
      },
    ]);

    await expect(fetchHashnoteUsycSource()).resolves.toBeNull();
  });

  it("does not keep a rate-derived USYC proxy that can outrank the live Hashnote feed", () => {
    expect(RATE_DERIVED_CONFIGS.some((config) => config.stablecoinId === "usyc-hashnote")).toBe(false);
  });
});

describe("fetchLiquityV2StabilityPoolSource", () => {
  const TEST_START_SEC = 1_800_000_000;

  const TEST_CHAIN_RPCS = new Map<string, ChainRpcConfig>([
    [
      "base",
      makeChainRpcConfig({
        chainId: "base",
        chainName: "Base",
        rpcUrls: ["https://rpc.example/base", "https://rpc-fallback.example/base"],
        explorerUrl: "https://basescan.org",
      }),
    ],
    [
      "ethereum",
      makeChainRpcConfig({
        chainId: "ethereum",
        chainName: "Ethereum",
        rpcUrls: ["https://rpc.example/ethereum", "https://rpc-fallback.example/ethereum"],
        explorerUrl: "https://etherscan.io",
      }),
    ],
  ]);

  const E18 = 10n ** 18n;
  const E36 = 10n ** 36n;
  const AGG_WEIGHTED_DEBT_SUM_SELECTOR = "0x42635a95";
  const SHUTDOWN_TIME_SELECTOR = "0x58569081";
  const TOTAL_COLLATERALS_SELECTOR = "0x30504b6f";
  const TOTAL_BOLD_DEPOSITS_SELECTOR = "0xf71c6940";

  interface BranchValues {
    yearlyInterest: bigint;
    shutdownTime: bigint;
    deposits: bigint;
  }

  function uint256Hex(value: bigint): string {
    return `0x${value.toString(16).padStart(64, "0")}`;
  }

  function stubBranchRpc(
    config: LiquityV2SpSourceConfig,
    values: readonly BranchValues[],
    options?: { failRead?: { branchIndex: number; selector: string }; registryCount?: bigint },
  ) {
    function resolveCall(to: string | undefined, data: string | undefined): string {
      if (to === config.collateralRegistry && data === TOTAL_COLLATERALS_SELECTOR) {
        return uint256Hex(options?.registryCount ?? BigInt(config.branches.length));
      }
      for (const [index, branch] of config.branches.entries()) {
        if (options?.failRead?.branchIndex === index && options.failRead.selector === data) {
          // An empty eth_call result is not a valid uint256 word; the adapter
          // must reject the whole batch rather than publish a partial sum.
          return "0x";
        }
        if (to === branch.activePool && data === AGG_WEIGHTED_DEBT_SUM_SELECTOR) {
          return uint256Hex(values[index]!.yearlyInterest * E36);
        }
        if (to === branch.activePool && data === SHUTDOWN_TIME_SELECTOR) {
          return uint256Hex(values[index]!.shutdownTime);
        }
        if (to === branch.stabilityPool && data === TOTAL_BOLD_DEPOSITS_SELECTOR) {
          return uint256Hex(values[index]!.deposits * E18);
        }
      }
      throw new Error(`Unexpected eth_call: ${to ?? "missing-to"} ${data ?? "missing-data"}`);
    }

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Array<{
        id?: number;
        params?: Array<{ to?: string; data?: string } | string>;
      }>;
      if (!Array.isArray(body)) {
        throw new Error("Expected a JSON-RPC batch request from fetchEvmRpcBatch");
      }
      const envelopes = body.map((call) => {
        const params = typeof call.params?.[0] === "object" ? call.params[0] : null;
        return {
          jsonrpc: "2.0",
          id: call.id,
          result: resolveCall(params?.to?.toLowerCase(), params?.data),
        };
      });
      return new Response(JSON.stringify(envelopes), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }));
  }

  /** Branch interest/deposit pairs sized so the aggregate APR lands on 7.5%. */
  function buildBranchValues(config: LiquityV2SpSourceConfig): BranchValues[] {
    return config.branches.map((_branch, index) => ({
      yearlyInterest: BigInt(100 * (index + 1)),
      shutdownTime: 0n,
      deposits: BigInt(1_000 * (index + 1)),
    }));
  }

  describe.each([
    { name: "Base Dollar", config: BASEDOLLAR_SP_CONFIG },
    { name: "Liquity V2", config: LIQUITY_V2_SP_CONFIG },
  ])("($name)", ({ config }) => {
    afterEach(cleanupYieldSourceTest);

    it("computes the deposit-weighted interest-only APR across all branches", async () => {
      const values = buildBranchValues(config);
      stubBranchRpc(config, values);

      const totalDeposits = values.reduce((total, branch) => total + Number(branch.deposits), 0);
      const result = await fetchLiquityV2StabilityPoolSource(TEST_START_SEC, config, undefined, TEST_CHAIN_RPCS);

      // B11/D8 — the missing stamp made these rows `source-freshness-unknown` and the
      // coin unscorable; keep it pinned so a dropped field fails here instead.
      expect(result?.sourceObservedAt).toBe(TEST_START_SEC);
      expect(Number.isFinite(result?.sourceObservedAt)).toBe(true);

      expect(result).toEqual(
        expect.objectContaining({
          currentApy: expect.closeTo(7.5, 10),
          apyBase: expect.closeTo(7.5, 10),
          apyReward: null,
          sourcePool: null,
          sourceTvlUsd: totalDeposits,
          dataSource: "onchain",
          exchangeRate: null,
          sourceKey: `onchain:${config.stablecoinId}`,
          yieldSource: config.sourceLabel,
          yieldType: "lending-vault",
        }),
      );
    });

    it("excludes a shutdown branch's interest but retains its deposits", async () => {
      const values = buildBranchValues(config);
      const shutdownIndex = config.branches.length - 1;
      stubBranchRpc(config, values.map((branch, index) => (
        index === shutdownIndex ? { ...branch, shutdownTime: 1n } : branch
      )));

      const totalDeposits = values.reduce((total, branch) => total + Number(branch.deposits), 0);
      const activeInterest = values
        .filter((_branch, index) => index !== shutdownIndex)
        .reduce((total, branch) => total + Number(branch.yearlyInterest), 0);
      const result = await fetchLiquityV2StabilityPoolSource(TEST_START_SEC, config, undefined, TEST_CHAIN_RPCS);

      expect(result?.currentApy).toBeCloseTo(75 * activeInterest / totalDeposits, 10);
      expect(result?.sourceTvlUsd).toBe(totalDeposits);
    });

    it("fails closed when any branch read in the batch is unreadable", async () => {
      stubBranchRpc(config, buildBranchValues(config), {
        failRead: { branchIndex: config.branches.length - 1, selector: SHUTDOWN_TIME_SELECTOR },
      });

      await expect(fetchLiquityV2StabilityPoolSource(TEST_START_SEC, config, undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
    });

    it("fails closed when the CollateralRegistry reports more branches than configured", async () => {
      stubBranchRpc(config, buildBranchValues(config), {
        registryCount: BigInt(config.branches.length + 1),
      });

      await expect(fetchLiquityV2StabilityPoolSource(TEST_START_SEC, config, undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
    });

    it("returns null when total Stability Pool deposits are zero", async () => {
      stubBranchRpc(config, buildBranchValues(config).map((branch) => ({ ...branch, deposits: 0n })));

      await expect(fetchLiquityV2StabilityPoolSource(TEST_START_SEC, config, undefined, TEST_CHAIN_RPCS)).resolves.toBeNull();
    });

    it("returns null without a chain RPC for its deployment", async () => {
      stubBranchRpc(config, buildBranchValues(config));

      await expect(fetchLiquityV2StabilityPoolSource(TEST_START_SEC, config, undefined, new Map())).resolves.toBeNull();
    });
  });
});

describe("fetchMorphoVaultSources", () => {
  afterEach(cleanupYieldSourceTest);

  it("returns yield sources for stablecoin vaults", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_121_600_000);
    const fetchSpy = mockMorpho([
      morphoVault({ state: { netApy: 0.02968, totalAssetsUsd: 142_917_322, fee: 0 } }),
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results.length).toBe(1);
    const requests = fetchSpy.mock.calls.map((call) => JSON.parse(call[1]?.body as string) as { variables: { symbols: string[] } });
    expect(requests.every((request) => request.variables.symbols.length <= 100)).toBe(true);
    expect(requests.length).toBeGreaterThan(1);
    const request = { variables: { symbols: requests.flatMap((entry) => entry.variables.symbols) } };
    expect(request.variables.symbols).toContain("USDC");
    expect(request.variables.symbols).not.toEqual([
      "USDC",
      "USDT",
      "DAI",
      "USDS",
      "GHO",
      "FRAX",
      "PYUSD",
      "FRXUSD",
      "crvUSD",
      "DOLA",
      "LUSD",
    ]);
    expect(results[0]).toStrictEqual({
      stablecoinId: "usdc-circle", symbol: "USDC", chain: "ethereum",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      yield: {
        currentApy: 2.968, apyBase: 2.968, apyReward: null,
        sourcePool: "0x9eF4cb75FeD5b3913219E881E0FF0b10a6761CF3",
        sourceTvlUsd: 142_917_322, dataSource: "protocol-api", exchangeRate: null,
        sourceKey: "protocol-api:morpho-vault:ethereum:0x9ef4cb75fed5b3913219e881e0ff0b10a6761cf3",
        yieldSource: "Morpho: Gauntlet USDC Prime", yieldType: "lending-opportunity",
        sourceObservedAt: 1_790_121_600, comparisonAnchorObservedAt: null,
      },
    });
  });

  it("reports a degraded fetch on HTTP error", async () => {
    mockYieldSourceRoutes([{ match: "api.morpho.org", body: { error: "internal server error" }, status: 500 }]);
    await expect(fetchMorphoVaultSources()).resolves.toEqual({ candidates: [], degraded: true });
  });

  it.each([0, 0.03])("accepts the tracked vault only with positive APY (%s)", async (netApy) => {
    mockMorpho([
      morphoVault({ address: "0xabc", name: "Empty Vault", state: { netApy, totalAssetsUsd: 1_000_000, fee: 0 } }),
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results.map((result) => result.yield.sourceKey)).toEqual(
      netApy === 0 ? [] : ["protocol-api:morpho-vault:ethereum:0xabc"],
    );
  });

  it("skips a malformed item but keeps a valid one on the same page", async () => {
    mockMorpho([
      morphoVault({ name: "Missing address", address: undefined }),
      morphoVault(),
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe("USDC");
  });

  it("skips vaults whose asset address is missing or not tracked", async () => {
    mockMorpho([
      morphoVault({ address: "0xabc", name: "Missing Asset Address", asset: { symbol: "USDC" } }),
      morphoVault({ address: "0xdef", name: "Spoofed Asset Address", asset: { symbol: "USDC", address: "0xdead000000000000000000000000000000000000", }, state: { netApy: 0.42, totalAssetsUsd: 1_000_000, fee: 0 } }),
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results).toEqual([]);
  });

  it("uses tracked chain/address identity before returned symbols", async () => {
    mockMorpho([
      morphoVault({ address: "0xabc", name: "Wrong USDC", asset: { symbol: "USDC", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", } }),
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        stablecoinId: "usdt-tether",
        symbol: "USDT",
      }),
    );
  });

  it.each(["http", "parse"] as const)("preserves %s failure's pagination retention policy", async (failure) => {
    const vault = morphoVault({ address: "0xAbC", name: "USDC" });
    let page = 0;
    mockYieldSourceRoutes([{
      match: "api.morpho.org", matchBody: '"USDC"',
      respond: () => ++page === 1
        ? { body: { data: { vaults: { items: Array.from({ length: 100 }, () => vault) } } } }
        : failure === "http" ? { status: 500, body: {} } : new Response("{"),
    }, { match: "api.morpho.org", body: { data: { vaults: { items: [] } } } }]);
    const result = await fetchMorphoVaultSources();
    expect(result.degraded).toBe(true);
    expect(result.candidates).toHaveLength(failure === "http" ? 100 : 0);
    expect(page).toBe(2);
  });
});

describe.each([
  ["Morpho", fetchMorphoVaultSources],
  ["Pendle", fetchPendleMarketSources],
  ["Kong", fetchYearnKongSources],
  ["Beefy", fetchBeefySources],
] as const)("%s supplemental lifecycle", (_name, fetchSources) => {
  afterEach(() => { vi.useRealTimers(); cleanupYieldSourceTest(); });

  it.each(["parent", "family"] as const)("preserves %s cancellation and cleans up the budget", async (kind) => {
    vi.useFakeTimers();
    const parent = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    })));
    const pending = fetchSources(parent.signal);
    const outcome = kind === "parent"
      ? expect(pending).rejects.toThrow("parent cancelled")
      : expect(pending).resolves.toStrictEqual({ candidates: [], degraded: true });
    if (kind === "parent") parent.abort(new Error("parent cancelled"));
    else await vi.advanceTimersByTimeAsync(25_000);
    await outcome;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("fetchPendleMarketSources", () => {
  afterEach(cleanupYieldSourceTest);

  it("fetches the three chain pages without authentication", async () => {
    const requests: Request[] = [];
    mockYieldSourceRoutes([1, 42161, 8453].map((chainId) => ({
      match: `https://api-v2.pendle.finance/core/v1/${chainId}/markets?limit=100&skip=0&is_active=true`,
      respond: (request: Request) => {
        requests.push(request);
        return { body: { results: [] } };
      },
    })), { strictUrl: true, requireMatch: true });

    expect(await fetchPendleMarketSources()).toEqual({ candidates: [], degraded: false });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.headers.get("Authorization") == null)).toBe(true);
  });

  const rateLimitCases: Array<{
    headers: Record<string, string>;
    backoffSec: number;
    source: "retry-after" | "x-ratelimit-weekly-reset" | "x-ratelimit-reset" | "default";
  }> = [
    { headers: { "Retry-After": "3600" }, backoffSec: 3600, source: "retry-after" },
    { headers: { "Retry-After": "Thu, 24 Sep 2026 00:00:00 GMT" }, backoffSec: 86400, source: "retry-after" },
    { headers: { "x-ratelimit-weekly-reset": "1790208000" }, backoffSec: 86400, source: "x-ratelimit-weekly-reset" },
    {
      headers: { "Retry-After": "60", "x-ratelimit-weekly-remaining": "0", "x-ratelimit-weekly-reset": "1790208000" },
      backoffSec: 86400, source: "x-ratelimit-weekly-reset",
    },
    {
      headers: { "x-ratelimit-weekly-remaining": "100", "x-ratelimit-weekly-reset": "1790208000", "x-ratelimit-reset": "1790121660" },
      backoffSec: 60, source: "x-ratelimit-reset",
    },
    { headers: { "Retry-After": "invalid" }, backoffSec: 86400, source: "default" },
    { headers: { "Retry-After": "999999999" }, backoffSec: 7 * 86400, source: "retry-after" },
  ];

  it.each(rateLimitCases)("stops on the first 429 and preserves the retry window ($source, $backoffSec)", async ({ headers, backoffSec, source }) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-23T00:00:00Z"));
    const fetch = mockYieldSourceRoutes([{
      match: "/core/v1/1/markets?",
      respond: () => new Response("quota exhausted", { status: 429, headers }),
    }], { requireMatch: true });
    expect(await fetchPendleMarketSources()).toEqual({
      candidates: [], degraded: true, rateLimited: { backoffSec, source },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("extracts stablecoin market yields from Pendle REST API", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_121_600_000);
    const futureExpiry = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    mockYieldSourceRoutes([
      {
        match: "/core/v1/1/markets?",
        body: {
          total: 1,
          limit: 100,
          skip: 0,
          results: [
            pendleMarket({ expiry: futureExpiry, categoryIds: ["stables", "rwa"] }),
          ],
        },
      },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    const { candidates: results } = await fetchPendleMarketSources();
    expect(results[0]).toStrictEqual({
      symbol: "USDG", chain: "ethereum", address: "0xdef",
      yield: {
        currentApy: 5.2, apyBase: 5.2, apyReward: null, sourcePool: "0xAbC",
        sourceTvlUsd: 82_000_000, dataSource: "protocol-api", exchangeRate: null,
        sourceKey: "protocol-api:pendle:ethereum:0xabc",
        yieldSource: "Pendle fixed yield: Global Dollar USDG", yieldType: "fixed-yield",
        sourceObservedAt: 1_790_121_600, comparisonAnchorObservedAt: null,
      },
    });
  });

  it("filters out non-stablecoin markets", async () => {
    const futureExpiry = new Date(Date.now() + 30 * 86400 * 1000).toISOString();
    mockYieldSourceRoutes([
      {
        match: "/core/v1/1/markets?",
        body: {
          total: 1,
          limit: 100,
          skip: 0,
          results: [
            pendleMarket({ address: "0xabc", expiry: futureExpiry, impliedApy: 0.1, underlyingApy: 0.05, aggregatedApy: 0.1, underlyingAsset: { symbol: "ETH", address: "0xdef" }, assetRepresentation: "ETH", protocol: "Lido", liquidity: { usd: 200_000_000 }, categoryIds: ["eth-staking"] }),
          ],
        },
      },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    const { candidates: results } = await fetchPendleMarketSources();
    expect(results).toEqual([]);
  });

  it("filters expired and implausibly high implied APY markets", async () => {
    mockYieldSourceRoutes([
      {
        match: "/core/v1/1/markets?",
        body: {
          total: 2,
          limit: 100,
          skip: 0,
          results: [
            pendleMarket({ id: "1-0xexpired", address: "0xexpired", expiry: new Date(Date.now() - 86400 * 1000).toISOString() }),
            pendleMarket({ id: "1-0xhigh", address: "0xhigh", impliedApy: 1.5, aggregatedApy: 1.5 }),
          ],
        },
      },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    await expect(fetchPendleMarketSources()).resolves.toEqual({ candidates: [], degraded: false });
  });

  it("keeps same-address markets on distinct chains", async () => {
    mockYieldSourceRoutes([1, 42161, 8453].map((chainId) => ({
      match: `/core/v1/${chainId}/markets?`,
      body: { results: [pendleMarket({ address: "0xabc", chainId, impliedApy: 0.05, underlyingAsset: { symbol: "USDC", address: "0xdef" }, assetRepresentation: "USDC", protocol: "Test", liquidity: { usd: 2_000_000 }, id: undefined, underlyingApy: undefined, aggregatedApy: undefined })] },
    })), { requireMatch: true });
    expect((await fetchPendleMarketSources()).candidates.map((result) => result.yield.sourceKey)).toEqual([
      "protocol-api:pendle:ethereum:0xabc",
      "protocol-api:pendle:arbitrum:0xabc",
      "protocol-api:pendle:base:0xabc",
    ]);
  });

  it("reports a degraded fetch when a chain page fails", async () => {
    mockYieldSourceRoutes([
      { match: "/core/v1/1/markets?", body: { error: "upstream unavailable" }, status: 500 },
      { match: "/core/v1/42161/markets?", body: { results: [] } },
      { match: "/core/v1/8453/markets?", body: { results: [] } },
    ]);

    await expect(fetchPendleMarketSources()).resolves.toEqual({ candidates: [], degraded: true });
  });

  it("keeps first-chain rows and continues after a second-chain parse failure", async () => {
    const market = pendleMarket({ impliedApy: 0.05, underlyingAsset: { symbol: "USDC", address: "0xdef" }, assetRepresentation: "USDC", protocol: "Test", liquidity: { usd: 2_000_000 }, id: undefined, underlyingApy: undefined, aggregatedApy: undefined });
    const fetch = mockYieldSourceRoutes([
      { match: "/core/v1/1/markets?", body: { results: [market] } },
      { match: "/core/v1/42161/markets?", respond: () => new Response("{") },
      { match: "/core/v1/8453/markets?", body: { results: [{ ...market, chainId: 8453 }] } },
    ], { requireMatch: true });
    const result = await fetchPendleMarketSources();
    expect(result.degraded).toBe(true);
    expect(result.candidates.map((row) => row.yield.sourceKey)).toEqual([
      "protocol-api:pendle:ethereum:0xabc", "protocol-api:pendle:base:0xabc",
    ]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("fetchReProtocolReusdSource", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanupYieldSourceTest();
  });

  it("publishes the latest valid reUSD observation when both Re products are present", async () => {
    mockYieldSourceRoutes([{
      match: "api.re.xyz/price",
      body: {
        success: true,
        data: {
          reUSD: [
            { apy: 8.4, date: "2026-07-14", price: 1.099 },
            { apy: 8.1, date: "2026-07-15", price: 1.1 },
          ],
          reUSDe: [
            { apy: 24.63, date: "2026-07-14", price: 1.388167 },
            { apy: 12.24, date: "2026-07-15", price: 1.388632 },
          ],
        },
      },
    }]);

    await expect(fetchReProtocolReusdSource()).resolves.toEqual({
      currentApy: 8.1,
      apyBase: 8.1,
      apyReward: null,
      sourcePool: "0x5086bf358635B81D8C47C66d1C8b9E567Db70c72",
      sourceTvlUsd: null,
      dataSource: "protocol-api",
      exchangeRate: 1.1,
      sourceKey: "protocol-api:re-protocol-reusd",
      yieldSource: "Re Protocol Basis-Plus (reUSD)",
      yieldType: "nav-appreciation",
      sourceObservedAt: Date.parse("2026-07-15T00:00:00Z") / 1000,
      comparisonAnchorObservedAt: null,
    });
  });

  it.each([
    {
      name: "does not substitute reUSDe when the reUSD series is absent",
      data: { reUSDe: [{ apy: 15, date: "2026-07-15", price: 1.38 }] },
    },
    {
      name: "fails closed when reUSD observations are stale",
      data: { reUSD: [{ apy: 8, date: "2026-07-12", price: 1.09 }] },
    },
    {
      name: "fails closed on malformed or out-of-envelope observations",
      data: {
        reUSD: [
          { apy: 501, date: "2026-07-15", price: 1.09 },
          { apy: 8, date: "not-a-date", price: 1.09 },
          { apy: 8, date: "2026-07-15", price: 0 },
        ],
      },
    },
  ])("$name", async ({ data }) => {
    mockYieldSourceRoutes([{
      match: "api.re.xyz/price",
      body: { success: true, data },
    }]);
    await expect(fetchReProtocolReusdSource()).resolves.toBeNull();
  });
});

describe("fetchCurveScrvusdCurrentRateSource", () => {
  const TEST_CHAIN_RPCS = new Map<string, ChainRpcConfig>([
    [
      "ethereum",
      makeChainRpcConfig({
        chainId: "ethereum",
        chainName: "Ethereum",
        rpcUrls: ["https://rpc.example/eth"],
        explorerUrl: "https://etherscan.io",
      }),
    ],
  ]);

  function uint256Hex(value: bigint): string {
    return `0x${value.toString(16).padStart(64, "0")}`;
  }

  function stubScrvusdRpc(values: Record<string, bigint>) {
    mockYieldSourceRoutes([{
      match: "rpc.example/eth",
      respond: async (request) => {
        const body = await request.clone().json() as {
          id: number;
          params?: Array<{ data?: string } | string>;
        };
        const callData = typeof body.params?.[0] === "object" ? body.params[0]?.data : null;
        const result = callData ? values[callData] : null;
        if (result == null) {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: uint256Hex(result) }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }], { requireMatch: true });
  }

  afterEach(cleanupYieldSourceTest);

  it("computes current APY from the Yearn V3 profit-unlock rate", async () => {
    stubScrvusdRpc({
      // totalAssets()
      "0x01e1d114": 30158843267975775812534801n,
      // totalSupply()
      "0x18160ddd": 27472111994438379962910025n,
      // profitUnlockingRate()
      "0x5141eebb": 36466621655966695427862704847n,
      // fullProfitUnlockDate()
      "0x2d632692": 1776150466n,
    });

    const result = await fetchCurveScrvusdCurrentRateSource(1775891171, undefined, TEST_CHAIN_RPCS);

    expect(result).toEqual(
      expect.objectContaining({
        apyReward: null,
        sourcePool: "5fd328af-4203-471b-bd16-1705c726d926",
        dataSource: "onchain",
        exchangeRate: null,
        sourceKey: "onchain:scrvusd-curve:scrvusd-current-rate",
        sourceObservedAt: 1775891171,
        comparisonAnchorObservedAt: null,
        yieldSource: "Curve Savings (scrvUSD)",
        yieldType: "governance-set",
      }),
    );
    expect(result?.currentApy).toBeCloseTo(4.2747, 4);
    expect(result?.apyBase).toBeCloseTo(4.2747, 4);
    expect(result?.sourceTvlUsd).toBeCloseTo(30_158_843.2679, 3);
  });

  it("returns a zero current rate when the profit-unlock window has ended", async () => {
    stubScrvusdRpc({
      "0x01e1d114": 30158843267975775812534801n,
      "0x18160ddd": 27472111994438379962910025n,
      "0x5141eebb": 36466621655966695427862704847n,
      "0x2d632692": 1775891170n,
    });

    const result = await fetchCurveScrvusdCurrentRateSource(1775891171, undefined, TEST_CHAIN_RPCS);

    expect(result?.currentApy).toBe(0);
    expect(result?.apyBase).toBe(0);
  });
});

describe("fetchYearnKongSources", () => {
  afterEach(cleanupYieldSourceTest);

  it("skips retired vaults", async () => {
    mockYieldSourceRoutes([
      {
        match: "kong.yearn.fi",
        matchBody: '"chainId":1}',
        body: {
          data: {
            vaults: [
              kongVault({ address: "0x123", name: "Old USDC", tvl: { close: 1_000_000 }, apy: { net: 0.02, monthlyNet: 0.02 }, meta: { category: "Stablecoin", isRetired: true } }),
            ],
          },
        },
      },
      { match: "kong.yearn.fi", body: { data: { vaults: [] } } },
    ]);
    expect(await fetchYearnKongSources()).toEqual({ candidates: [], degraded: false });
  });

  it("labels non-Yearn vaults as Kong", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_121_600_000);
    mockYieldSourceRoutes([
      {
        match: "kong.yearn.fi",
        matchBody: '"chainId":1}',
        body: {
          data: {
            vaults: [
              kongVault({ name: "Steakhouse USDC", yearn: false }),
            ],
          },
        },
      },
      { match: "kong.yearn.fi", body: { data: { vaults: [] } } },
    ]);
    const { candidates: results } = await fetchYearnKongSources();
    expect(results[0]).toStrictEqual({
      stablecoinId: undefined, symbol: "USDC", chain: "ethereum", address: null,
      yield: {
        currentApy: 3, apyBase: 3, apyReward: null, sourcePool: "0xabc",
        sourceTvlUsd: 50_000_000, dataSource: "protocol-api", exchangeRate: null,
        sourceKey: "protocol-api:kong:ethereum:0xabc",
        yieldSource: "Kong: Steakhouse USDC", yieldType: "lending-opportunity",
        sourceObservedAt: 1_790_121_600, comparisonAnchorObservedAt: null,
      },
    });
  });

  it("uses current net APY instead of monthly net APY", async () => {
    mockYieldSourceRoutes([
      {
        match: "kong.yearn.fi",
        matchBody: '"chainId":1}',
        body: {
          data: {
            vaults: [
              kongVault({ apy: { net: 0.025, monthlyNet: 0.1 } }),
            ],
          },
        },
      },
      { match: "kong.yearn.fi", body: { data: { vaults: [] } } },
    ]);

    const { candidates: results } = await fetchYearnKongSources();
    expect(results[0].yield.currentApy).toBeCloseTo(2.5);
    expect(results[0].yield.apyBase).toBeCloseTo(2.5);
  });

  it("maps Staked yBOLD to sBOLD as a native K3 source", async () => {
    mockYieldSourceRoutes([
      {
        match: "kong.yearn.fi",
        matchBody: '"chainId":1}',
        body: {
          data: {
            vaults: [
              kongVault({ address: "0x23346B04a7f55b8760E5860AA5A77383D63491cD", name: "Staked yBOLD", asset: { symbol: "yBOLD", address: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8", }, tvl: { close: 4_434_056 }, apy: { net: 0.0316603818860981, monthlyNet: 0.0316603818860981 } }),
            ],
          },
        },
      },
      { match: "kong.yearn.fi", body: { data: { vaults: [] } } },
    ]);

    const { candidates: results } = await fetchYearnKongSources();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(
      expect.objectContaining({
        stablecoinId: "sbold-k3-capital",
        symbol: "yBOLD",
        chain: "ethereum",
        address: "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8",
        yield: expect.objectContaining({
          currentApy: expect.closeTo(3.17, 1),
          sourceKey: "protocol-api:k3:ethereum:0x23346b04a7f55b8760e5860aa5a77383d63491cd",
          yieldSource: "K3: sBOLD",
          yieldType: "lending-vault",
        }),
      }),
    );
  });

  it("keeps same-address vaults on distinct chains and deduplicates within a chain", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_790_121_600_000)
      .mockReturnValueOnce(1_790_121_601_000)
      .mockReturnValue(1_790_121_602_000);
    const vault = kongVault({ address: "0xAbC", apy: { net: 0.03 } });
    mockYieldSourceRoutes([
      ...[1, 8453].map((chainId) => ({
        match: "kong.yearn.fi", matchBody: `"chainId":${chainId}}`,
        body: { data: { vaults: [vault, { ...vault, address: "0xabc" }] } },
      })),
      { match: "kong.yearn.fi", body: { data: { vaults: [] } } },
    ]);
    const { candidates } = await fetchYearnKongSources();
    expect(candidates.map((result) => result.yield.sourceKey)).toEqual([
      "protocol-api:yearn:ethereum:0xabc", "protocol-api:yearn:base:0xabc",
    ]);
    expect(candidates.map((result) => result.yield.sourceObservedAt)).toEqual([1_790_121_601, 1_790_121_602]);
  });

  it("reports a degraded fetch when a chain query fails", async () => {
    mockYieldSourceRoutes([{ match: "kong.yearn.fi", body: { error: "upstream unavailable" }, status: 500 }]);

    await expect(fetchYearnKongSources()).resolves.toEqual({ candidates: [], degraded: true });
  });

  it("keeps first-chain rows and continues after a second-chain parse failure", async () => {
    const vault = kongVault({ address: "0xAbC", tvl: { close: 1_000_000 }, apy: { net: 0.03 }, meta: { category: "Stablecoin" } });
    const fetch = mockYieldSourceRoutes([
      { match: "kong.yearn.fi", matchBody: '"chainId":1}', body: { data: { vaults: [vault] } } },
      { match: "kong.yearn.fi", matchBody: '"chainId":10}', respond: () => new Response("{") },
      { match: "kong.yearn.fi", matchBody: '"chainId":8453}', body: { data: { vaults: [vault] } } },
      { match: "kong.yearn.fi", body: { data: { vaults: [] } } },
    ]);
    const result = await fetchYearnKongSources();
    expect(result.degraded).toBe(true);
    expect(result.candidates.map((row) => row.yield.sourceKey)).toEqual([
      "protocol-api:yearn:ethereum:0xabc", "protocol-api:yearn:base:0xabc",
    ]);
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe("fetchYearnYboldSource", () => {
  const YBOLD_VAULT = "0x9F4330700a36B29952869fac9b33f45EEdd8A3d8";
  const YSYBOLD_VAULT = "0x23346B04a7f55b8760E5860AA5A77383D63491cD";
  const BOLD_TOKEN = "0x6440f144b7e50D6a8439336510312d2F54beB01D";

  function ydaemonRoutes(overrides?: { ybold?: unknown; ysybold?: unknown }) {
    return [
      {
        match: `ydaemon.yearn.fi/1/vaults/${YSYBOLD_VAULT.toLowerCase()}`,
        body: overrides?.ysybold ?? {
          address: YSYBOLD_VAULT,
          token: { address: YBOLD_VAULT },
          tvl: { tvl: 5_696_768.16 },
          apr: { netAPR: 0.07073882937691378 },
          info: { isRetired: false },
        },
      },
      {
        match: `ydaemon.yearn.fi/1/vaults/${YBOLD_VAULT.toLowerCase()}`,
        body: overrides?.ybold ?? {
          address: YBOLD_VAULT,
          token: { address: BOLD_TOKEN },
          tvl: { tvl: 5_783_996.57 },
          apr: { netAPR: 0 },
          info: { isRetired: false },
        },
      },
    ];
  }

  afterEach(cleanupYieldSourceTest);

  it("publishes the yBOLD vault TVL with the staked ysyBOLD net APR", async () => {
    mockYieldSourceRoutes(ydaemonRoutes());

    await expect(fetchYearnYboldSource()).resolves.toEqual(
      expect.objectContaining({
        currentApy: expect.closeTo(7.073882937691378, 10),
        apyBase: expect.closeTo(7.073882937691378, 10),
        apyReward: null,
        sourcePool: YBOLD_VAULT.toLowerCase(),
        sourceTvlUsd: 5_783_996.57,
        dataSource: "protocol-api",
        exchangeRate: null,
        sourceKey: "protocol-api:yearn:ybold",
        yieldSource: "Yearn yBOLD Stability Pool vault",
        yieldType: "lending-vault",
      }),
    );
  });

  it.each([
    {
      name: "fails closed when the staked vault no longer wraps the tracked yBOLD vault",
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: "0x0000000000000000000000000000000000000001" },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 0.07 },
        info: { isRetired: false },
      },
    },
    {
      name: "fails closed when the yBOLD vault no longer wraps BOLD",
      ybold: {
        address: YBOLD_VAULT,
        token: { address: "0x0000000000000000000000000000000000000002" },
        tvl: { tvl: 5_783_996.57 },
        apr: { netAPR: 0 },
        info: { isRetired: false },
      },
    },
    {
      name: "returns null when Yearn retires the staked vault",
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: YBOLD_VAULT },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 0.07 },
        info: { isRetired: true },
      },
    },
    {
      name: "returns null when Yearn reports no staked return",
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: YBOLD_VAULT },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 0 },
        info: { isRetired: false },
      },
    },
    {
      name: "returns null when the yBOLD vault TVL is below the publication floor",
      ybold: {
        address: YBOLD_VAULT,
        token: { address: BOLD_TOKEN },
        tvl: { tvl: 1_000 },
        apr: { netAPR: 0 },
        info: { isRetired: false },
      },
    },
    {
      name: "returns null when the reported APR exceeds the accepted envelope",
      ysybold: {
        address: YSYBOLD_VAULT,
        token: { address: YBOLD_VAULT },
        tvl: { tvl: 5_696_768.16 },
        apr: { netAPR: 2.5 },
        info: { isRetired: false },
      },
    },
  ])("$name", async (overrides) => {
    mockYieldSourceRoutes(ydaemonRoutes(overrides));
    await expect(fetchYearnYboldSource()).resolves.toBeNull();
  });
});

describe("fetchZephyrZysSource", () => {
  afterEach(cleanupYieldSourceTest);

  it("parses Zephyr historical returns into a ZYS protocol-api source row", async () => {
    mockYieldSourceRoutes([
      {
        match: "zephyrprotocol.com/api/v1/historicalreturns",
        headers: { "x-last-success-at": "1778592715928" },
        body: {
          lastBlock: { return: 0.00003408784470093992, zsd_accrued: 0.1069333381892648, effectiveApy: 9.2377 },
          oneDay: { return: 0.02472608440340735, zsd_accrued: 78.0483693688002, effectiveApy: 9.3084 },
          oneWeek: { return: 0.1766115414394089, zsd_accrued: 556.5930792781874, effectiveApy: 9.4994 },
        },
      },
    ]);

    const result = await fetchZephyrZysSource();

    expect(result).toEqual(
      expect.objectContaining({
        currentApy: 9.3084,
        apyBase: 9.3084,
        apyReward: null,
        sourcePool: null,
        sourceTvlUsd: null,
        dataSource: "protocol-api",
        exchangeRate: null,
        sourceKey: "protocol-api:zys-zephyr-protocol",
        yieldSource: "Zephyr Scanner ZYS returns",
        yieldType: "nav-appreciation",
        // B17 — the upstream success time is floored to a stable hourly bucket so
        // repeated reads cannot write a new phantom row per call.
        sourceObservedAt: 1_778_590_800,
        comparisonAnchorObservedAt: null,
      }),
    );
  });

  it("rejects an observation clock beyond the future-skew allowance", async () => {
    mockYieldSourceRoutes([
      {
        match: "zephyrprotocol.com/api/v1/historicalreturns",
        headers: { "x-last-success-at": String((Math.floor(Date.now() / 1000) + 2 * 3600) * 1000) },
        body: { oneDay: { effectiveApy: 9.3084 } },
      },
    ]);

    await expect(fetchZephyrZysSource()).resolves.toBeNull();
  });

  it.each([
    {
      name: "refuses to date a payload the upstream marks x-stale",
      route: {
        headers: { "x-last-success-at": "1778592715928", "x-stale": "1" },
        body: { oneDay: { effectiveApy: 9.3084 } },
      },
    },
    {
      name: "returns null when the one-day effective APY is missing",
      route: {
        body: {
          lastBlock: { return: 0.00003408784470093992, zsd_accrued: 0.1069333381892648, effectiveApy: 9.2377 },
          oneDay: { return: 0.02472608440340735, zsd_accrued: 78.0483693688002 },
        },
      },
    },
    {
      name: "returns null on HTTP error",
      route: { status: 500, body: "" },
    },
  ])("$name", async ({ route }) => {
    mockYieldSourceRoutes([{ match: "zephyrprotocol.com/api/v1/historicalreturns", ...route }]);
    await expect(fetchZephyrZysSource()).resolves.toBeNull();
  });
});
