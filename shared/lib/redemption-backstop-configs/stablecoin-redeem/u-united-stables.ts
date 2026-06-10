import { documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, reviewedDirectRedemptionSupplyFull } from "./shared";

export const U_UNITED_STABLES_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...reviewedDirectRedemptionSupplyFull,
  accessModel: "whitelisted-onchain",
  costModel: documentedVariableFee(
    "Smart contract mint/burn 1:1 against whitelisted stablecoins (USDC, USDT, USD1); on-chain oracles enforce collateral backing",
  ),
  docs: [
    sourceRef("United Stables", "https://www.u.tech/", ["capacity"]),
    sourceRef("United Stables terms", "https://www.u.tech/terms/", ["route", "fees", "access"]),
  ],
});
