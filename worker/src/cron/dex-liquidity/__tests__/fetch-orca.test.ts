import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { fetchOrcaPools } from "../fetch-orca";
import { convertToGtNewPools, normalizeDexApiPoolsForMerge } from "../../../lib/dex-api-pool-shaping";

function orcaPool(decimalsA: number, decimalsB: number, balanceA = "1000000") {
  return {
    address: "PoolCase", price: "1", tvlUsdc: "100000", feeRate: 100,
    tokenA: { address: "MintA", symbol: "USDC", decimals: decimalsA },
    tokenB: { address: "MintB", symbol: "USDT", decimals: decimalsB },
    tokenBalanceA: balanceA, tokenBalanceB: "1000000", stats: { "24h": { volume: "0" } },
  };
}

describe("fetchOrcaPools", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([[6, 6.5], [6.5, 6], [-1, 6], [6, 256]])(
    "retains identity and TVL but withholds invalid-decimal balances (%s, %s)",
    async (decimalsA, decimalsB) => {
      mockFetch([{ match: "api.orca.so/v2/solana/pools", body: { data: [orcaPool(decimalsA, decimalsB)] } }], { requireMatch: true });
      const result = await fetchOrcaPools();
      expect(result.pools).toHaveLength(1);
      expect(result.pools[0]).toMatchObject({
        poolAddress: "PoolCase", tvlUsd: 100000, balances: null, balancesNormalized: false,
        tokens: [{ decimals: decimalsA }, { decimals: decimalsB }],
      });
      expect(result.warnings).toContain("pool PoolCase: invalid-token-decimals; balances unavailable");
      const normalized = normalizeDexApiPoolsForMerge(result.pools);
      expect(normalized.skippedInvalidUnitCount).toBe(0);
      const shaped = convertToGtNewPools(
        normalized.pools, new Map([["solana:MintA", "usdc-circle"]]), new Map(),
      ).get("usdc-circle")![0]!;
      expect(shaped.tvlUsd).toBe(100000);
      expect(shaped.measurement?.balanceMeasured).toBe(false);
      expect(shaped.balanceRatio).toBeUndefined();
      expect(shaped.balanceDetails).toBeUndefined();
      expect(shaped.ammExecutionModel).toBeUndefined();
    },
  );

  it.each([
    [0, 6, "0", [0, 1]],
    [6, 6, "1000000", [1, 1]],
    [255, 255, "1000000", [1e-249, 1e-249]],
  ] as const)("admits integer decimal boundaries and genuine zero (%s, %s)", async (a, b, rawA, balances) => {
    mockFetch([{ match: "api.orca.so/v2/solana/pools", body: { data: [orcaPool(a, b, rawA)] } }], { requireMatch: true });
    const result = await fetchOrcaPools();
    expect(result.pools[0]).toMatchObject({ tvlUsd: 100000, balancesNormalized: true, volume24hUsd: 0 });
    expect(result.pools[0]!.balances).toHaveLength(2);
    for (let index = 0; index < balances.length; index++) {
      const expected = balances[index]!;
      const actual = result.pools[0]!.balances![index]!;
      if (expected === 0) expect(actual).toBe(0);
      else expect(actual / expected).toBeCloseTo(1, 12);
    }
    expect(result.warnings).toEqual([]);
  });
});
