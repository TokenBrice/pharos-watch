import { documentedVariableFee, sourceRef, type RedemptionBackstopConfig, stablecoinRedeemBase } from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";

export const USD0_USUAL_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...reviewedDirectRedemptionSupplyFull,
  outputAssetType: "mixed-collateral",
  costModel: documentedVariableFee(
    "Redeemable 1:1 for underlying RWA assets via DaoCollateral contract; minting accepts USYC or USDC via gateway",
  ),
  docs: [
    sourceRef(
      "Usual USD0 mint and redeem",
      "https://docs.usual.money/usual-products/usd0-stablecoin/usd0/flow-and-architecture",
      ["route", "capacity", "access", "settlement"],
    ),
    sourceRef(
      "Usual USD0 DaoCollateral",
      "https://tech.usual.money/smart-contracts/protocol-contracts/usd0/usd0-daocollateral",
      ["route", "fees"],
    ),
  ],
};
