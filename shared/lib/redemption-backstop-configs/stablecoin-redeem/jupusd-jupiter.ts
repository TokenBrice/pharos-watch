import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_DIRECT_REDEMPTION_AT } from "./shared";

export const JUPUSD_JUPITER_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  accessModel: "whitelisted-onchain",
  capacityModel: {
    kind: "reserve-sync-metadata",
    fallbackRatio: 0.1,
    confidence: "documented-bound",
    basis: "hot-buffer",
  },
  costModel: fixedFee(
    4,
    "Jupiter's JupUSD fee FAQ states the JupUSD program applies a 0.04% fee to mint and redeem transactions.",
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
    sourceRef("JupUSD fees FAQ", "https://jupiverse.zendesk.com/hc/en-us/articles/24441752163740-What-fees-apply-to-JupUSD", [
      "fees",
    ]),
  ],
  notes: [
    "Current model keeps the reviewed 10% USDC liquidity buffer disclosed in public materials as the immediate bound rather than assuming the full reserve stack is always user-accessible through the primary mint/redeem rail",
  ],
});
