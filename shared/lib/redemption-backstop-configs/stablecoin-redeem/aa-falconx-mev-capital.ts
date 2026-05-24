import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const AA_FALCONX_MEV_CAPITAL_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  accessModel: "whitelisted-onchain",
  settlementModel: "days",
  executionModel: "rules-based-nav",
  outputAssetType: "nav",
  costModel: undisclosedReviewedFee(
    "Idle Perpetual Yield Tranches expose CDO tranche redemption mechanics; public materials reviewed do not publish one fixed senior-tranche redemption fee",
  ),
  docs: [
    sourceRef("Idle Yield Tranches methods", "https://docs.idle.finance/developers/yield-tranches/methods", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef(
      "Pareto credit vault addresses",
      "https://docs.pareto.credit/developers/addresses/product/credit-vaults",
      ["route", "capacity", "access"],
    ),
  ],
  notes: [
    "Modeled as a NAV tranche exit to underlying USDC exposure, with whitelist and CDO-liquidity constraints rather than an issuer fiat redemption route.",
  ],
};
