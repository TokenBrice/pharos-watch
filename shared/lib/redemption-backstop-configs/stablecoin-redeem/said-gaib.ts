import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const SAID_GAIB_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  reviewedAt: REVIEWED_STABLECOIN_AUDIT_AT,
  capacityModel: { kind: "reserve-sync-metadata" },
  settlementModel: "queued",
  executionModel: "rules-based-nav",
  outputAssetType: "nav",
  costModel: fixedFee(
    0,
    "sAID exits to AID through a monthly FIFO withdrawal cycle at unstaking NAV; verified source exposes no separate unstaking-fee deduction",
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
    "Fresh ERC-4626 reserve telemetry reads the vault's idle AID balance as the current redeemable bound while the monthly FIFO cycle still governs settlement; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
