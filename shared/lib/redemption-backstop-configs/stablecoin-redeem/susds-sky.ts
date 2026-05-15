import {
  documentedBoundSupplyFull,
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_WRAPPER_REDEMPTION_AT } from "./shared";

export const SUSDS_SKY_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
  executionModel: "rules-based-nav",
  costModel: fixedFee(0, "Sky docs describe sUSDS vault deposits and withdrawals with no fee"),
  docs: [
    sourceRef("Sky sUSDS docs", "https://developers.sky.money/core-protocol/susds/", ["route", "capacity", "fees"]),
    sourceRef("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/", ["route", "capacity"]),
  ],
  notes: [
    "sUSDS is an ERC-4626 savings wrapper over USDS: holders can deposit USDS to mint sUSDS and redeem back into USDS at the live vault exchange rate",
    "The wrapper exits immediately into USDS, after which the underlying Sky stablecoin keeps its own direct PSM-backed exit quality",
  ],
};
