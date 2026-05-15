import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";

export const U_UNITED_STABLES_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...reviewedDirectRedemptionSupplyFull,
  accessModel: "whitelisted-onchain",
  costModel: documentedVariableFee(
    "Smart contract mint/burn 1:1 against whitelisted stablecoins (USDC, USDT, USD1); on-chain oracles enforce collateral backing",
  ),
};
