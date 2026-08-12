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

import { fetchOriginVaultBalancesReserves } from "../origin-vault-balances";
import { fetchOnchainUint256 } from "../helpers";

describe("fetchOriginVaultBalancesReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses OUSD vault checkBalance and reconciles against totalValue", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(5_000_000n * 10n ** 6n)
      .mockResolvedValueOnce(1_250_000n * 10n ** 6n)
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
        depType: "collateral",
      },
    ]);
    expect(result.warnings).toBeUndefined();
    expect(result.metadata).toMatchObject({
      freshnessMode: "not-applicable",
      totalReserveUsd: 5_000_000,
      totalValueUsd: 5_000_000,
      assetCoverageRatio: 1,
      immediateRedeemableUsd: 1_250_000,
      idleVaultBalances: [
        {
          name: "USDC deployed through Origin OUSD strategies",
          value: 1_250_000,
          raw: (1_250_000n * 10n ** 6n).toString(),
          coinId: "usdc-circle",
        },
      ],
      redemption: {
        capacityUsd: 1_250_000,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        sourceUrls: ["https://analytics.originprotocol.com/"],
      },
      details: {
        proofKind: "origin-vault-check-balance",
      },
    });
    expect(vi.mocked(fetchOnchainUint256).mock.calls[1]?.[0]).toMatchObject({
      contract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      data: "0x70a08231000000000000000000000000e75d77b1865ae93c7eaa3040b038d7aa7bc02f70",
    });
  });
});
