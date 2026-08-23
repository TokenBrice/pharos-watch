import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchDefiLlamaPrices: vi.fn(),
    fetchOnchainUint256,
    makeOnchainCallers: makeOnchainCallersMock({ uint256: fetchOnchainUint256 }),
  };
});

import { adaptFx, fetchFxReserves } from "../fx";
import { fetchDefiLlamaPrices, fetchOnchainUint256 } from "../helpers";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("adaptFx", () => {
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

  it("reads configured f(x) pools directly on-chain for score-grade freshness", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(2n * 10n ** 18n)
      .mockResolvedValueOnce(3_000n * 10n ** 18n)
      // fx getTotalRawCollaterals uses a unified 1e18 raw scale, even for WBTC.
      .mockResolvedValueOnce(1n * 10n ** 18n)
      .mockResolvedValueOnce(60_000n * 10n ** 18n);
    vi.mocked(fetchDefiLlamaPrices).mockResolvedValue(new Map([
      ["wstETH", 4_000],
      ["wbtc", 100_000],
    ]));

    const coin = TRACKED_META_BY_ID.get("fxusd-f-x-protocol");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchFxReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(fetchOnchainUint256).toHaveBeenCalledTimes(4);
    expect(result.slices).toEqual([
      { name: "WBTC", pct: 92.6, risk: "medium" },
      { name: "wstETH (Lido)", pct: 7.4, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      immediateRedeemableUsd: 63_000,
      details: {
        proofKind: "fx-pool-direct-onchain",
        poolCount: 2,
      },
      redemption: {
        capacityUsd: 63_000,
        capacityKind: "live-proxy-validated",
        freshnessKind: "same-run-api",
      },
    });
  });
});
