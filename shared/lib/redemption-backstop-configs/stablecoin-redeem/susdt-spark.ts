import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const SUSDT_SPARK_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("Spark savings vault withdrawals redeem spUSDT for USDT at the live vault exchange rate; no separate fixed protocol fee was identified in reviewed public docs"),
  docs: [
    sourceRef("Spark docs", "https://docs.spark.fi/", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Spark app", "https://spark.fi/", ["route"]),
  ],
};
