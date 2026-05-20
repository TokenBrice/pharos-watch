import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const SGHO_AAVE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("Aave sGHO previewRedeem path exits to GHO at the contract exchange rate; public docs reviewed do not publish a separate fixed redemption fee"),
  docs: [
    sourceRef("Aave sGHO guide", "https://aave.com/docs/aave-v3/guides/sgho", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Aave sGHO governance configuration", "https://governance.aave.com/t/arfc-sgho-launch-configuration/24346", ["route", "capacity", "access"]),
  ],
  notes: [
    "This route models the current legacy sGHO/stkGHO-compatible contract's previewRedeem exit into GHO, not the separate Aave Umbrella stkGHO safety-module cooldown route.",
  ],
};
