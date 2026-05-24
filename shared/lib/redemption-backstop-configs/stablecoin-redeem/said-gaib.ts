import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const SAID_GAIB_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  outputAssetType: "nav",
  costModel: undisclosedReviewedFee(
    "sAID exits to AID through a monthly FIFO withdrawal cycle at unstaking NAV; public docs reviewed do not publish one fixed unstaking fee",
  ),
  docs: [
    sourceRef("GAIB sAID docs", "https://docs.gaib.ai/products/gaib-products/staked-ai-dollar-said", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("GAIB AID docs", "https://docs.gaib.ai/products/gaib-products/ai-dollar-aid", ["route", "access"]),
  ],
  notes: [
    "sAID is not a $1-pegged wrapper; this route models the holder-exercisable withdrawal into AID at unstaking NAV, including possible unrealized-loss haircuts.",
    "Final AID redemption into supported stablecoins remains whitelisted for primary-market users, while regular users generally exit AID through app or DEX liquidity.",
  ],
};
