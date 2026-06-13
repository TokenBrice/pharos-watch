import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_DIRECT_REDEMPTION_AT } from "./shared";

export const JUPUSD_JUPITER_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  accessModel: "whitelisted-onchain",
  capacityModel: {
    kind: "reserve-sync-metadata",
    fallbackRatio: 0.1,
    confidence: "documented-bound",
    basis: "hot-buffer",
  },
  costModel: undisclosedReviewedFee(
    "JupUSD's primary mint and redeem rail is benefactor-gated and settles against USDC; public materials do not publish one universal fixed redemption fee",
  ),
  reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
  docs: [
    sourceRef("JupUSD homepage", "https://jupusd.money/", ["route", "capacity"]),
    sourceRef("Offside Labs JupUSD audit", "https://jupusd.money/homepage/audits/offsidelabs.pdf", [
      "route",
      "capacity",
      "access",
      "fees",
    ]),
  ],
  notes: [
    "Current model keeps the reviewed 10% USDC liquidity buffer disclosed in public materials as the immediate bound rather than assuming the full reserve stack is always user-accessible through the primary mint/redeem rail",
  ],
});
