import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const SUSDT_SPARK_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("Spark savings vault withdrawals redeem spUSDT for USDT at the live vault exchange rate; no separate fixed protocol fee was identified in reviewed public docs"),
  reviewedAt: "2026-05-17",
  docs: [
    sourceRef("Spark docs", "https://docs.spark.fi/", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Spark app", "https://spark.fi/", ["route"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDT balance as current direct redemption capacity; if the live snapshot is unavailable, the wrapper route is left unrated instead of assuming full-supply immediacy.",
  ],
};
