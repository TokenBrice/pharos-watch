import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";

export const SDOLA_INVERSE_FINANCE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull("2026-05-24"),
  totalScoreCap: 70,
  costModel: documentedVariableFee(
    "sDOLA docs describe deposits and redemptions through the ERC-4626 wrapper at the vault exchange rate; public materials reviewed do not publish a separate withdrawal fee",
  ),
  docs: [
    sourceRef("sDOLA docs", "https://docs.inverse.finance/inverse-finance/inverse-finance/products/tokens/dola/sdola", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef(
      "Inverse Peg Stability Module",
      "https://docs.inverse.finance/inverse-finance/inverse-finance/products/peg-stability-module",
      ["route", "capacity", "fees"],
    ),
  ],
  notes: [
    "Modeled route is the permissionless sDOLA wrapper exit into DOLA, not the downstream DOLA-to-USDS PSM path.",
    "Config-level cap reflects that unwrapping to DOLA does not by itself guarantee a full stablecoin exit; DOLA's own PSM capacity remains separately bounded.",
  ],
};
