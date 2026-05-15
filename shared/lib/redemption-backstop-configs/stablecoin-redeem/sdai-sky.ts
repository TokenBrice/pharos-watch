import {
  documentedBoundSupplyFull,
  fixedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_WRAPPER_REDEMPTION_AT } from "./shared";

export const SDAI_SKY_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_WRAPPER_REDEMPTION_AT),
  executionModel: "rules-based-nav",
  costModel: fixedFee(0, "Spark documents withdrawals from savings vaults without slippage or platform fees"),
  docs: [
    sourceRef("Spark website", "https://spark.fi/", ["route", "fees"]),
    sourceRef("Spark docs portal", "https://docs.spark.fi/", ["route", "capacity"]),
  ],
  notes: [
    "sDAI is the Dai Savings Rate wrapper: holders exit at the live ERC-4626 exchange rate into DAI rather than through a queued or discretionary process",
    "The wrapper leg is immediate; downstream par-exit quality is inherited from DAI's own PSM-backed redemption surface",
  ],
};
