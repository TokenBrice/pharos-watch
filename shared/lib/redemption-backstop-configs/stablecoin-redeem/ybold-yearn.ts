import { documentedBoundSupplyFull, fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const YBOLD_YEARN_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    0,
    "Yearn yBOLD docs state yBOLD is always redeemable for underlying BOLD without withdrawal fees or a waiting period.",
  ),
  docs: [
    sourceRef("Yearn yBOLD vault", "https://yearn.fi/v3/1/0x9f4330700a36b29952869fac9b33f45eedd8a3d8", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("Yearn yBOLD docs", "https://docs.yearn.fi/getting-started/products/yvaults/yBold", [
      "route",
      "capacity",
      "fees",
    ]),
    sourceRef("Yearn yBOLD API", "https://ydaemon.yearn.fi/1/vaults/0x9f4330700a36b29952869fac9b33f45eedd8a3d8", [
      "route",
      "capacity",
      "fees",
    ]),
  ],
  notes: [
    "yBOLD exits into BOLD through ERC-4626 withdrawal/redeem mechanics; downstream BOLD par exit remains Liquity's collateral-redemption route.",
    "The Yearn API currently identifies yBOLD as a tokenized BOLD Stability Pool product and reports zero management and performance fees.",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle BOLD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
