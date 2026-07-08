import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    makeOnchainCallers: vi.fn((input, options) => ({
      uint256: (contract: string, data: string) =>
        fetchOnchainUint256({
          ...options,
          contract,
          data,
          rpcMode: input.rpcMode,
          chain: input.chain,
        }),
      raw: vi.fn(),
    })),
  };
});

import { fetchBlastUsdbYieldManagerReserves } from "../blast-usdb-yield-manager";
import { fetchOnchainUint256 } from "../helpers";

describe("fetchBlastUsdbYieldManagerReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses USDYieldManager totalValue as USDB backing", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(120n * 10n ** 18n)
      .mockResolvedValueOnce(100n * 10n ** 18n);

    const coin = TRACKED_META_BY_ID.get("usdb-blast");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchBlastUsdbYieldManagerReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([
      {
        name: "MakerDAO DSR / DAI yield manager",
        pct: 100,
        risk: "low",
        coinId: "dai-makerdao",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 120,
      supplyUsd: 100,
      collateralizationRatio: 1.2,
      details: {
        proofKind: "blast-usdb-yield-manager-total-value",
        supplyChain: "blast",
      },
    });
  });

  it("degrades when manager value falls below supply", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(98n * 10n ** 18n)
      .mockResolvedValueOnce(100n * 10n ** 18n);

    const coin = TRACKED_META_BY_ID.get("usdb-blast");
    const result = await fetchBlastUsdbYieldManagerReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "blast-usdb-undercollateralized",
        effect: "degraded",
      }),
    ]);
  });
});
