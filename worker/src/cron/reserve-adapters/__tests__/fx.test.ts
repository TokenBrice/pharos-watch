import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchDefiLlamaPrices: vi.fn(),
    fetchJsonWithRetry: vi.fn(),
    fetchOnchainUint256,
    makeOnchainCallers: makeOnchainCallersMock({ uint256: fetchOnchainUint256 }),
  };
});

import { adaptFx, fetchFxReserves } from "../fx";
import { fetchDefiLlamaPrices, fetchJsonWithRetry, fetchOnchainUint256 } from "../helpers";


const fxCoin = TRACKED_META_BY_ID.get("fxusd-f-x-protocol")!;
const apiConfig = {
  ...fxCoin.liveReservesConfig!,
  inputs: { primary: { kind: "http-json" as const, url: "https://fx.example/tvl" } },
};

function mockApiPools(extra: Record<string, { collateralBalance: string }> = {}) {
  vi.mocked(fetchJsonWithRetry).mockResolvedValue({
    data: { poolInfo: {
      wstETH: { collateralBalance: "2000000000000000000" },
      wbtc: { collateralBalance: "100000000" },
      ...extra,
    } },
  });
  vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 4_000], ["wbtc", 100_000]]));
}
beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptFx", () => {
  it("fails closed at the HTTP consumer for unknown positive collateral", async () => {
    mockApiPools({ unexpectedAsset: { collateralBalance: "1" } });
    await expect(fetchFxReserves(fxCoin, apiConfig, new AbortController().signal))
      .rejects.toThrow("unmapped positive collateral keys with unquantified exposure: unexpectedAsset");
  });

  it("rejects a missing price instead of renormalizing the priced balance", async () => {
    mockApiPools();
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([["wstETH", 4_000]]));
    await expect(fetchFxReserves(fxCoin, apiConfig, new AbortController().signal))
      .rejects.toThrow("Missing DefiLlama price for wbtc");
  });

  it.each([
    ["0xee65a03c", "collateral"], ["0xf9d45fd2", "debt"],
  ])("rejects an independently unreadable on-chain %s read", async (selector, kind) => {
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) =>
      contract === "0x6Ecfa38FeE8a5277B91eFdA204c235814F0122E8" && data === selector
        ? null : 10n ** 18n);
    await expect(fetchFxReserves(fxCoin, fxCoin.liveReservesConfig!, new AbortController().signal))
      .rejects.toThrow(`fx on-chain ${kind} read failed for wstETH`);
  });

  it("values API WBTC at eight decimals rather than the on-chain eighteen", async () => {
    mockApiPools();
    const result = await fetchFxReserves(fxCoin, apiConfig, new AbortController().signal);
    expect(result.slices).toEqual([
      { name: "WBTC", pct: 92.6, risk: "medium" },
      { name: "wstETH (Lido)", pct: 7.4, risk: "low" },
    ]);
  });

  it("extracts non-zero collateral balances from the official fx TVL payload", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "4420184046004807062590", debtBalance: "1000000000000000000000" },
          wbtc: { collateralBalance: "21713855211", debtBalance: "2000000000000000000000" },
        },
      },
    });

    expect(result).toEqual({
      balances: [
        { key: "wstETH", amountRaw: 4420184046004807062590n, debtRaw: 1000000000000000000000n },
        { key: "wbtc", amountRaw: 21713855211n, debtRaw: 2000000000000000000000n },
      ],
      unknownKeys: [],
    });
  });

  it("surfaces unknown positive collateral keys so the fetch path can fail closed", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "1000000000000000000" },
          unexpectedAsset: { collateralBalance: "250000000000000000" },
        },
      },
    });

    expect(result).toEqual({
      balances: [{ key: "wstETH", amountRaw: 1000000000000000000n, debtRaw: 0n }],
      unknownKeys: ["unexpectedAsset"],
    });
  });

  it("treats non-numeric collateralBalance strings as zero (parse-failure path)", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "not-a-number", debtBalance: "1000" },
          wbtc: { collateralBalance: "-250", debtBalance: "0" },
        },
      },
    });

    // Both wstETH and wbtc parse to 0 -> filtered out; neither counts as unknown.
    expect(result.balances).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("returns an empty balance list and no unknowns when poolInfo is absent", () => {
    const result = adaptFx({});
    expect(result.balances).toEqual([]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("skips unknown keys with zero collateralBalance (no false-positive unknown list)", () => {
    const result = adaptFx({
      data: {
        poolInfo: {
          wstETH: { collateralBalance: "1000000000000000000" },
          retiredAsset: { collateralBalance: "0" },
        },
      },
    });
    expect(result.unknownKeys).toEqual([]);
  });

  it("values on-chain pool raw collateral in each pool's raw unit (stETH for the wstETH pool)", async () => {
    // Live f(x) pool state read on 2026-09-09 (review-evm-b.md EB1): the wstETH
    // pool's `getTotalRawCollaterals()` is stETH-denominated (the issuer API names
    // the same figure `stETHBalance`; the pool's actual wstETH holding is
    // 5225421081447982325287), while the WBTC pool's raw amount is WBTC on the
    // pool's unified 1e18 scale. Debts are fxUSD at 18 decimals. Prices are pinned
    // to the review snapshot so the fixture reproduces the corrected published
    // totals: wstETH 14.0% (the old wstETH-priced path published 16.9%), total
    // ≈ $115.38M, CR ≈ 1.444.
    const wstEthPoolRaw = 6498117380312973051552n; // stETH
    const wstEthPoolDebt = 8408069477417882708446823n;
    const wbtcPoolRaw = 1256573802172773285735n;
    const wbtcPoolDebt = 71492785220689011149058249n;
    const stEthPrice = 2485.83;
    const wbtcPrice = 78966.15;

    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(wstEthPoolRaw)
      .mockResolvedValueOnce(wstEthPoolDebt)
      .mockResolvedValueOnce(wbtcPoolRaw)
      .mockResolvedValueOnce(wbtcPoolDebt);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([
      ["wstETH", stEthPrice],
      ["wbtc", wbtcPrice],
    ]));

    const coin = TRACKED_META_BY_ID.get("fxusd-f-x-protocol");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchFxReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(fetchOnchainUint256).toHaveBeenCalledTimes(4);

    // Prices must be fetched for each pool's raw unit, not the wrapped token:
    // stETH for the wstETH pool. Pricing the stETH-denominated raw amount with
    // the wstETH price is the bug this fixture guards against.
    expect(vi.mocked(fetchDefiLlamaPrices).mock.calls[0]?.[0]).toEqual([
      { key: "wstETH", chain: "ethereum", address: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84" },
      { key: "wbtc", chain: "ethereum", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" },
    ]);

    expect(result.slices).toEqual([
      { name: "WBTC", pct: 86.0, risk: "medium" },
      { name: "wstETH (Lido)", pct: 14.0, risk: "low" },
    ]);

    const totalDebtUsd = (Number(wstEthPoolDebt) + Number(wbtcPoolDebt)) / 1e18;
    const totalReserveUsd = (Number(wstEthPoolRaw) / 1e18) * stEthPrice
      + (Number(wbtcPoolRaw) / 1e18) * wbtcPrice;
    expect(totalReserveUsd).toBeCloseTo(115_380_000, -3);
    expect(totalReserveUsd / totalDebtUsd).toBeCloseTo(1.444, 2);

    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      details: {
        proofKind: "fx-pool-direct-onchain",
        poolCount: 2,
      },
      redemption: {
        capacityKind: "live-proxy-validated",
        freshnessKind: "same-run-api",
      },
    });
    expect(result.metadata?.immediateRedeemableUsd).toBeCloseTo(totalDebtUsd, 6);
    expect(result.metadata?.redemption?.capacityUsd).toBeCloseTo(totalDebtUsd, 6);
  });
});
