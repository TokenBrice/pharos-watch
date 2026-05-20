import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";

export const USD0_USUAL_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...reviewedDirectRedemptionSupplyFull,
  outputAssetType: "mixed-collateral",
  costModel: documentedVariableFee(
    "Redeemable 1:1 for underlying RWA assets via DaoCollateral contract; minting accepts USYC or USDC via gateway",
  ),
};
