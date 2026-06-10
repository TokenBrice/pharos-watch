import { undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const SUSDC_SPARK_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "Spark savings vault withdrawals redeem spUSDC for USDC at the live vault exchange rate; no separate fixed protocol fee was identified in reviewed public docs",
  ),
  reviewedAt: "2026-05-17",
  docs: [
    sourceRef("Spark docs", "https://docs.spark.fi/", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Spark app", "https://spark.fi/", ["route"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDC balance as current direct redemption capacity; if the live snapshot is unavailable, the wrapper route is left unrated instead of assuming full-supply immediacy.",
  ],
});
