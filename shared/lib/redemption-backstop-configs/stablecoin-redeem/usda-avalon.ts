import { documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, reviewedDirectRedemptionSupplyFull } from "./shared";

export const USDA_AVALON_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...reviewedDirectRedemptionSupplyFull,
  settlementModel: "days",
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee(
    "USDa docs state holders can convert USDa to USDT 1:1 by bridging to Ethereum mainnet and depositing into the conversion vault, with claims available within one business day",
  ),
  docs: [
    sourceRef(
      "How to Use USDa",
      "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/how-to-use-usda",
      ["route", "capacity", "settlement"],
    ),
    sourceRef(
      "USDa risk management",
      "https://docs.avalonfinance.xyz/avalon-btcfi-products/cedefi-cdp-usda/risk-management",
      ["capacity"],
    ),
  ],
  notes: ["The modeled redemption rail is the documented USDa-to-USDT conversion vault on Ethereum mainnet rather than offchain BTC collateral withdrawals"],
});
