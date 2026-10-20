import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupYieldSourceTest, mockYieldSourceFetchRetryModule, mockYieldSourceRoutes } from "./yield-source.test-support";

vi.mock("../../lib/fetch-retry", () => mockYieldSourceFetchRetryModule());

import { fetchBeefySources, fetchMorphoVaultSources, fetchPendleMarketSources, fetchYearnKongSources } from "../yield-sync/sources-optional";

describe("fetchMorphoVaultSources", () => {
  afterEach(cleanupYieldSourceTest);

  it("returns yield sources for stablecoin vaults", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_790_121_600_000);
    const fetchSpy = mockYieldSourceRoutes([
      {
        match: "api.morpho.org",
        body: {
          data: {
            vaults: {
              items: [
                {
                  address: "0x9eF4cb75FeD5b3913219E881E0FF0b10a6761CF3",
                  name: "Gauntlet USDC Prime",
                  asset: {
                    symbol: "USDC",
                    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                  },
                  chain: { id: 1 },
                  state: { netApy: 0.02968, totalAssetsUsd: 142_917_322, fee: 0 },
                },
              ],
            },
          },
        },
      },
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
    mockYieldSourceRoutes([
      {
        match: "api.morpho.org",
        body: {
          data: {
            vaults: {
              items: [
                {
                  address: "0xabc",
                  name: "Empty Vault",
                  asset: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
                  chain: { id: 1 },
                  state: { netApy, totalAssetsUsd: 1_000_000, fee: 0 },
                },
              ],
            },
          },
        },
      },
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results.map((result) => result.yield.sourceKey)).toEqual(
      netApy === 0 ? [] : ["protocol-api:morpho-vault:ethereum:0xabc"],
    );
  });

  it("skips a malformed item but keeps a valid one on the same page", async () => {
    mockYieldSourceRoutes([
      {
        match: "api.morpho.org",
        body: {
          data: {
            vaults: {
              items: [
                {
                  name: "Missing address",
                  asset: {
                    symbol: "USDC",
                    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                  },
                  chain: { id: 1 },
                  state: { netApy: 0.03, totalAssetsUsd: 1_000_000, fee: 0 },
                },
                {
                  address: "0x9eF4cb75FeD5b3913219E881E0FF0b10a6761CF3",
                  name: "Gauntlet USDC Prime",
                  asset: {
                    symbol: "USDC",
                    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
                  },
                  chain: { id: 1 },
                  state: { netApy: 0.03, totalAssetsUsd: 1_000_000, fee: 0 },
                },
              ],
            },
          },
        },
      },
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results).toHaveLength(1);
    expect(results[0].symbol).toBe("USDC");
  });

  it("skips vaults whose asset address is missing or not tracked", async () => {
    mockYieldSourceRoutes([
      {
        match: "api.morpho.org",
        body: {
          data: {
            vaults: {
              items: [
                {
                  address: "0xabc",
                  name: "Missing Asset Address",
                  asset: { symbol: "USDC" },
                  chain: { id: 1 },
                  state: { netApy: 0.03, totalAssetsUsd: 1_000_000, fee: 0 },
                },
                {
                  address: "0xdef",
                  name: "Spoofed Asset Address",
                  asset: {
                    symbol: "USDC",
                    address: "0xdead000000000000000000000000000000000000",
                  },
                  chain: { id: 1 },
                  state: { netApy: 0.42, totalAssetsUsd: 1_000_000, fee: 0 },
                },
              ],
            },
          },
        },
      },
    ]);

    const { candidates: results } = await fetchMorphoVaultSources();
    expect(results).toEqual([]);
  });

  it("uses tracked chain/address identity before returned symbols", async () => {
    mockYieldSourceRoutes([
      {
        match: "api.morpho.org",
        body: {
          data: {
            vaults: {
              items: [
                {
                  address: "0xabc",
                  name: "Wrong USDC",
                  asset: {
                    symbol: "USDC",
                    address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
                  },
                  chain: { id: 1 },
                  state: { netApy: 0.03, totalAssetsUsd: 1_000_000, fee: 0 },
                },
              ],
            },
          },
        },
      },
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
    const vault = {
      address: "0xAbC", name: "USDC", chain: { id: 1 },
      asset: { symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
      state: { netApy: 0.03, totalAssetsUsd: 1_000_000, fee: 0 },
    };
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
