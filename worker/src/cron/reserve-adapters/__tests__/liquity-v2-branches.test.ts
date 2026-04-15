import { describe, expect, it } from "vitest";
import {
  buildLiquityV2RedemptionMetadata,
} from "../liquity-v2-branches";

const branch = {
  name: "WETH",
  holder: "0x1111111111111111111111111111111111111111",
  token: {
    chain: "ethereum",
    address: "0x2222222222222222222222222222222222222222",
    decimals: 18,
  },
  risk: "very-low" as const,
};

describe("buildLiquityV2RedemptionMetadata", () => {
  it("publishes same-run direct redemption capacity from active-pool debt", () => {
    const metadata = buildLiquityV2RedemptionMetadata({
      balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
      redemptionFeeBps: 52,
      debts: [
        {
          entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
          debtRaw: 1_250_000_000_000_000_000_000n,
          shutDown: false,
        },
      ],
    });

    expect(metadata).toMatchObject({
      immediateRedeemableUsd: 1250,
      redemptionFeeBps: 52,
      redemption: {
        capacityUsd: 1250,
        capacityKind: "live-direct-bounded",
        freshnessKind: "same-run-onchain",
        routeStatus: "open",
        holderEligibility: "any-holder",
        settlementDelaySec: 0,
        feeBps: 52,
      },
      details: {
        proofKind: "liquity-v2-active-pool-debt",
      },
    });
  });

  it("degrades route status when a branch is shut down", () => {
    const metadata = buildLiquityV2RedemptionMetadata({
      balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
      redemptionFeeBps: null,
      debts: [
        {
          entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
          debtRaw: 1_250_000_000_000_000_000_000n,
          shutDown: true,
        },
      ],
    });

    expect(metadata.redemption).toMatchObject({
      routeStatus: "degraded",
      routeStatusReason: "Collateral branch shutdown detected for: WETH",
    });
  });

  it("fails closed when active-pool debt is zero", () => {
    expect(() => buildLiquityV2RedemptionMetadata({
      balances: [{ branch, balanceRaw: 2_000_000_000_000_000_000n }],
      redemptionFeeBps: null,
      debts: [
        {
          entry: { branch, balanceRaw: 2_000_000_000_000_000_000n },
          debtRaw: 0n,
          shutDown: false,
        },
      ],
    })).toThrow("active-pool debt reads returned zero capacity");
  });
});
