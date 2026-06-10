import { documentedBoundSupplyFull, undisclosedReviewedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const YBOLD_YEARN_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "Yearn yBOLD ERC-4626 withdraw/redeem returns BOLD at the live vault exchange rate; reviewed public docs and app metadata do not publish one fixed redemption fee",
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
    "The Yearn API currently identifies yBOLD as a tokenized BOLD Stability Pool product and reports zero management, performance, deposit, and withdrawal fees, but the modeled route keeps fees as documented-variable rather than a fixed zero-fee guarantee.",
    "Fresh ERC-4626 reserve telemetry reads the vault's idle BOLD balance as current direct wrapper capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
