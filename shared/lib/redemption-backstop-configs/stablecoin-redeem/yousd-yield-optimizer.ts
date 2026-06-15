import { fixedFee } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const YOUSD_YIELD_OPTIMIZER_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  settlementModel: "immediate",
  executionModel: "rules-based-nav",
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.2, basis: "strategy-buffer" },
  costModel: fixedFee(
    0,
    "YO docs state protocol deposit and withdrawal fees are currently set to 0; instant redemptions depend on the available liquidity buffer.",
  ),
  reviewedAt: "2026-04-16",
  notes: [
    "The 20% ratio is a reviewed heuristic reflecting ERC-4626 vault liquidity-buffer behavior rather than a published instant-liquidity floor",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle underlying balance as current direct redemption capacity; the prior reviewed 20% heuristic is retained only as fallback when live metadata is unavailable.",
  ],
});
