import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_DIRECT_REDEMPTION_AT } from "./shared";

export const USR_RESOLV_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "supply-ratio", ratio: 0.1, confidence: "documented-bound" },
  costModel: undisclosedReviewedFee(),
  reviewedAt: REVIEWED_DIRECT_REDEMPTION_AT,
  docs: [
    sourceRef("Resolv docs", "https://docs.resolv.xyz/", ["route", "capacity"]),
    sourceRef("Resolv Apostro reserves", "https://info.apostro.xyz/resolv-reserves", ["capacity"]),
  ],
  notes: [
    "Resolv docs describe USR as mintable and redeemable 1:1 by users against collateral",
    "The reviewed 10% bound matches the tracked USD stablecoin buffer rather than assuming the full delta-neutral reserve stack is immediately withdrawable",
  ],
});
