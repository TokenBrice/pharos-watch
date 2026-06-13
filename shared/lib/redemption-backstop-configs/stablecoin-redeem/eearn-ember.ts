import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const EEARN_EMBER_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata", fallbackRatio: 0.05, basis: "strategy-buffer" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "Ember Earn vault withdrawals redeem eEARN shares to USDC when vault liquidity is available; public docs reviewed do not publish one fixed redemption fee",
  ),
  reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
  docs: [
    sourceRef("Ember Earn", "https://trade.bluefin.io/ember/eEARN", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef(
      "Ethereum eEARN contract",
      "https://etherscan.io/address/0x9be9294722f8aad37b11a9792be2c782182cafa2#readContract",
      ["route", "capacity", "access"],
    ),
    sourceRef("Royco Dawn eEARN market", "https://dawn.royco.org/", ["route", "capacity"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; the reviewed 5% strategy-buffer ratio is retained only as fallback when live metadata is unavailable.",
  ],
});
