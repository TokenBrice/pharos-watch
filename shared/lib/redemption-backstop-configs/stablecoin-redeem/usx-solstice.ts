import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, reviewedDirectRedemptionSupplyFull } from "./shared";

export const USX_SOLSTICE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...reviewedDirectRedemptionSupplyFull,
  accessModel: "whitelisted-onchain",
  costModel: undisclosedReviewedFee(
    "Direct minting and redemption of USX is reserved for KYC'd institutional investors depositing or withdrawing USDC and USDT through the Solstice protocol; public fee schedule not disclosed",
  ),
  docs: [sourceRef("Solstice USX", "https://solstice.finance/usx", ["route", "capacity", "access"])],
  notes: [
    "Retail users access USX primarily through DEX liquidity or the Solstice platform, while the primary mint/redeem rail is institution-only",
  ],
});
