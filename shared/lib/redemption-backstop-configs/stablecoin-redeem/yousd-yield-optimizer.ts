import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";

export const YOUSD_YIELD_OPTIMIZER_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  settlementModel: "immediate",
  executionModel: "rules-based-nav",
  capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "heuristic", basis: "strategy-buffer" },
  costModel: documentedVariableFee(
    "ERC-4626 vault; instant redemptions up to liquidity buffer, larger withdrawals up to 24h as cross-chain positions unwind",
  ),
  reviewedAt: "2026-04-16",
  notes: [
    "The 20% ratio is a reviewed heuristic reflecting ERC-4626 vault liquidity-buffer behavior rather than a published instant-liquidity floor",
  ],
};
