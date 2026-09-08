import { beforeEach, describe, expect, it, vi } from "vitest";
import ousd from "@shared/data/stablecoins/coins/ousd-origin-protocol.json";
import type { StablecoinMeta } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";

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

import { fetchOriginVaultBalancesReserves } from "../origin-vault-balances";
import { fetchOnchainUint256 } from "../helpers";

const coin = ousd as unknown as StablecoinMeta;
const config = ousd.liveReservesConfig as LiveReservesConfig;

function fetchReserves(candidate = config) {
  return fetchOriginVaultBalancesReserves(coin, candidate, new AbortController().signal);
}

describe("fetchOriginVaultBalancesReserves", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses OUSD vault checkBalance and reconciles against totalValue", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(5_000_000n * 10n ** 6n)
      .mockResolvedValueOnce(1_250_000n * 10n ** 6n)
      .mockResolvedValueOnce(5_000_000n * 10n ** 18n);

    const result = await fetchReserves();

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
  it("distinguishes failed invested, idle and total-value probes", async () => {
    for (const [failed, message] of [
      ["0x5f515226", /checkBalance failed/],
      ["0x70a08231", /idle balance probe failed/],
      ["0xd4c3eea0", /totalValue probe failed/],
    ] as const) {
      vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) => {
        if (data.startsWith(failed)) return null;
        return data.startsWith("0xd4c3eea0") ? 100n * 10n ** 18n : 100n * 10n ** 6n;
      });
      await expect(fetchReserves()).rejects.toThrow(message);
    }
  });

  it("rejects zero total value and zero aggregate reserves independently", async () => {
    for (const [reserve, total, message] of [
      [100n * 10n ** 6n, 0n, /totalValue probe failed/],
      [0n, 100n * 10n ** 18n, /zero reserve value/],
    ] as const) {
      vi.mocked(fetchOnchainUint256).mockImplementation(async ({ data }) =>
        data.startsWith("0xd4c3eea0") ? total : reserve);
      await expect(fetchReserves()).rejects.toThrow(message);
    }
  });

  it("degrades incomplete asset coverage without confusing idle liquidity with backing", async () => {
    vi.mocked(fetchOnchainUint256)
      .mockResolvedValueOnce(80n * 10n ** 6n)
      .mockResolvedValueOnce(20n * 10n ** 6n)
      .mockResolvedValueOnce(100n * 10n ** 18n);
    const result = await fetchReserves();
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 80, totalValueUsd: 100, assetCoverageRatio: 0.8,
      redemption: { capacityUsd: 20 },
    });
    expect(result.warnings).toEqual([expect.objectContaining({ code: "origin-vault-coverage-gap", effect: "degraded" })]);
  });

  it("normalizes mixed asset decimals and sums idle capacity separately", async () => {
    const candidate = structuredClone(config);
    candidate.params = {
      ...candidate.params,
      assets: [
        { address: "0x1111111111111111111111111111111111111111", decimals: 6, name: "USDC", risk: "low" },
        { address: "0x2222222222222222222222222222222222222222", decimals: 18, name: "DAI", risk: "low" },
      ],
    };
    vi.mocked(fetchOnchainUint256).mockImplementation(async ({ contract, data }) => {
      if (data === "0xd4c3eea0") return 100n * 10n ** 18n;
      const first = data.endsWith("1".repeat(40)) || contract === "0x1111111111111111111111111111111111111111";
      const idle = data.startsWith("0x70a08231");
      return first ? (idle ? 7n : 40n) * 10n ** 6n : (idle ? 11n : 60n) * 10n ** 18n;
    });
    const result = await fetchReserves(candidate);
    expect(result.slices).toEqual([
      { name: "DAI", pct: 60, risk: "low" },
      { name: "USDC", pct: 40, risk: "low" },
    ]);
    expect(result.metadata).toMatchObject({ totalReserveUsd: 100, assetCoverageRatio: 1, redemption: { capacityUsd: 18 } });
    expect(result.warnings).toBeUndefined();
  });
});
