import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { reviewedDirectRedemptionSupplyFull } from "./shared";

export const USDAI_USD_AI_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...reviewedDirectRedemptionSupplyFull,
  reviewedAt: "2026-04-03",
  costModel: documentedVariableFee(
    "USD.AI's current app flow and issuer guidance indicate base USDai is minted and redeemed instantly against PYUSD, while the longer unstaking queue applies to sUSDai rather than base USDai",
  ),
  docs: [
    sourceRef("USD.AI buy / stake", "https://docs.usd.ai/app-guide/buy-stake", ["route", "capacity"]),
    sourceRef("USD.AI app buy flow", "https://app.usd.ai/buy", ["route"]),
  ],
  notes: ["Current route models the base USDai burn-and-withdraw path into PYUSD; the asynchronous queue applies to sUSDai unstaking, not direct USDai redemption"],
};
