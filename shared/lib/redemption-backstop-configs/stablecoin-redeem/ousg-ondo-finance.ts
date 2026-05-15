import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  stablecoinRedeemBase,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";

export const OUSG_ONDO_FINANCE_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...reviewedDirectRedemptionSupplyFull,
  accessModel: "whitelisted-onchain",
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee(
    "Instant mint/redemption at daily NAV via OUSGInstantManager against USDC (T+0 via BUIDL on-chain liquidity)",
  ),
  notes: ["Token transfers restricted to KYC-verified whitelisted addresses on-chain"],
};
