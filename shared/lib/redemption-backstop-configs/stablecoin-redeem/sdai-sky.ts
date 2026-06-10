import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig } from "./shared";

export const SDAI_SKY_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(0, "Spark documents withdrawals from savings vaults without slippage or platform fees"),
  reviewedAt: "2026-05-17",
  docs: [
    sourceRef("Spark website", "https://spark.fi/", ["route", "fees"]),
    sourceRef("Spark docs portal", "https://docs.spark.fi/", ["route", "capacity"]),
  ],
  notes: [
    "sDAI is the Dai Savings Rate wrapper: holders exit at the live ERC-4626 exchange rate into DAI rather than through a queued or discretionary process",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle DAI balance as current direct wrapper capacity; downstream par-exit quality is inherited from DAI's own PSM-backed redemption surface.",
  ],
});
