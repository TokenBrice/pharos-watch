import { undisclosedReviewedFee, type RedemptionBackstopConfig, sourceRef, stablecoinRedeemBase } from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const GTUSDC_GAUNTLET_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "supply-ratio", ratio: 0.05, confidence: "heuristic", basis: "strategy-buffer" },
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
};
