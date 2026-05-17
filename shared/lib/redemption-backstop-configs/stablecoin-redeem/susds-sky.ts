import {
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const SUSDS_SKY_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(0, "Sky docs describe sUSDS vault deposits and withdrawals with no fee"),
  reviewedAt: "2026-05-17",
  docs: [
    sourceRef("Sky sUSDS docs", "https://developers.sky.money/core-protocol/susds/", ["route", "capacity", "fees"]),
    sourceRef("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/", ["route", "capacity"]),
  ],
  notes: [
    "sUSDS is an ERC-4626 savings wrapper over USDS: holders can deposit USDS to mint sUSDS and redeem back into USDS at the live vault exchange rate",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle USDS balance as current direct wrapper capacity; final par-exit quality still depends on USDS's own PSM-backed exit surface.",
  ],
};
