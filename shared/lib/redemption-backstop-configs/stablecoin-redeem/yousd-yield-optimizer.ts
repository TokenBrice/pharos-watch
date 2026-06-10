import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";

export const YOUSD_YIELD_OPTIMIZER_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  settlementModel: "immediate",
  executionModel: "rules-based-nav",
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.2, basis: "strategy-buffer" },
  costModel: documentedVariableFee(
    "ERC-4626 vault; instant redemptions up to liquidity buffer, larger withdrawals up to 24h as cross-chain positions unwind",
  ),
  reviewedAt: "2026-04-16",
  notes: [
    "The 20% ratio is a reviewed heuristic reflecting ERC-4626 vault liquidity-buffer behavior rather than a published instant-liquidity floor",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle underlying balance as current direct redemption capacity; the prior reviewed 20% heuristic is retained only as fallback when live metadata is unavailable.",
  ],
};
