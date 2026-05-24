import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const YVUSDC_YEARN_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(
    "Yearn v3 vault withdrawals redeem yvUSDC-1 to USDC at the live vault exchange rate; public docs reviewed do not publish one fixed redemption fee",
  ),
  docs: [
    sourceRef("Yearn v3 USDC vault", "https://yearn.fi/v3/1/0xbe53a109b494e5c9f97b9cd39fe969be68bf6204", [
      "route",
      "capacity",
      "fees",
      "access",
      "settlement",
    ]),
    sourceRef("Yearn docs", "https://docs.yearn.fi/", ["route", "capacity", "fees", "access", "settlement"]),
  ],
};
