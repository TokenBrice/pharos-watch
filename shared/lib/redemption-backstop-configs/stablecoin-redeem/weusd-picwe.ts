import { documentedBoundSupplyFull, fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const WEUSD_PICWE_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
  costModel: fixedFee(100, "PicWe docs describe a 1% WEUSD redemption fee"),
  docs: [
    sourceRef("PicWe WEUSD", "https://docs.picwe.org/what-is-weusd", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("PicWe mint and redeem", "https://docs.picwe.org/mint-and-redeem", ["route", "fees"]),
  ],
});
