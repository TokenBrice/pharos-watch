import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  const { makeOnchainCallersMock } = await import("./helpers/onchain-callers-mock");
  const fetchOnchainUint256 = vi.fn();
  return {
    ...actual,
    fetchOnchainUint256,
    makeOnchainCallers: makeOnchainCallersMock({ uint256: fetchOnchainUint256 }),
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
