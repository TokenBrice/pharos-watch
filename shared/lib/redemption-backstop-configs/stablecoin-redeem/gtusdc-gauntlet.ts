import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const GTUSDC_GAUNTLET_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "MetaMorpho vault withdrawals redeem to USDC when vault liquidity is available; public docs reviewed do not publish one fixed redemption fee",
  ),
  reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
  docs: [
    sourceRef("Morpho vault docs", "https://docs.morpho.org/curation/overview", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef(
      "Gauntlet USDC Core vault",
      "https://app.morpho.org/ethereum/vault/0xdd0f28e19c1780eb6396170735d45153d261490d/gauntlet-usdc-core",
      ["route", "capacity", "access"],
    ),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; the prior reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
  ],
});
