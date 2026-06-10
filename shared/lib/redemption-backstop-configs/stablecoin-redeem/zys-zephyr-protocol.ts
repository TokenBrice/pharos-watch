import { documentedBoundSupplyFull, documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const ZYS_ZEPHYR_PROTOCOL_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "rules-based-nav",
  outputAssetType: "nav",
  costModel: documentedVariableFee(
    "Zephyr conversion fees are absorbed by reserves and depend on protocol conversion-rate mechanics rather than a single published fixed bps fee",
  ),
  docs: [
    sourceRef("Zephyr integration documentation", "https://zephyrprotocol.com/documentation", ["route", "capacity", "access"]),
    sourceRef("Zephyr conversions dashboard", "https://zephyrprotocol.com/network/conversions", ["route", "fees", "settlement"]),
    sourceRef("Zephyr emission and yield reserve", "https://zephyrprotocol.com/network/emission", ["capacity"]),
  ],
  notes: [
    "ZYS is a Zephyr yield-share asset rather than a flat $1 token; the route is modeled as protocol conversion / redemption of the yield share's ZSD reserve value.",
    "Final dollar exit inherits the underlying ZSD protocol collateral redemption route.",
  ],
});
