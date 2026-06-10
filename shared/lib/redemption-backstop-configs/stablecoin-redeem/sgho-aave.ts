import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const SGHO_AAVE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "Aave sGHO previewRedeem path exits to GHO at the contract exchange rate; public docs reviewed do not publish a separate fixed redemption fee",
  ),
  docs: [
    sourceRef("Aave sGHO guide", "https://aave.com/docs/aave-v3/guides/sgho", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef(
      "Aave sGHO governance configuration",
      "https://governance.aave.com/t/arfc-sgho-launch-configuration/24346",
      ["route", "capacity", "access"],
    ),
  ],
  notes: [
    "This route models the current legacy sGHO/stkGHO-compatible contract's previewRedeem exit into GHO, not the separate Aave Umbrella stkGHO safety-module cooldown route.",
    "Fresh sGHO telemetry scores the contract's live previewRedeem(totalSupply) output as current direct redemption capacity into GHO; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
};
