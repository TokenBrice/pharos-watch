import { beforeEach, describe, expect, it, vi } from "vitest";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    fetchOnchainUint256: vi.fn(),
  };
});

import { fetchOriginVaultBalancesReserves } from "../origin-vault-balances";
import { fetchOnchainUint256 } from "../helpers";

describe("fetchOriginVaultBalancesReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses OUSD vault checkBalance and reconciles against totalValue", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(5_000_000n * 10n ** 6n)
      .mockResolvedValueOnce(5_000_000n * 10n ** 18n);

    const coin = TRACKED_META_BY_ID.get("ousd-origin-protocol");
    expect(coin?.liveReservesConfig).toBeDefined();

    const result = await fetchOriginVaultBalancesReserves(
      coin!,
      coin!.liveReservesConfig!,
      AbortSignal.timeout(5_000),
    );

    expect(result.slices).toEqual([
      {
        name: "USDC deployed through Origin OUSD strategies",
        pct: 100,
        risk: "medium",
        coinId: "usdc-circle",
        depType: "wrapper",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 5_000_000,
      totalValueUsd: 5_000_000,
      assetCoverageRatio: 1,
      details: {
        proofKind: "origin-vault-check-balance",
      },
    });
  });
});
