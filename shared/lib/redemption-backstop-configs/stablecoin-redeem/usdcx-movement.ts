import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const USDCX_MOVEMENT_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "deterministic-onchain",
  costModel: documentedVariableFee("Circle xReserve docs describe 1:1 USDCx burn/release against USDC; public materials reviewed do not publish a separate fixed redemption fee"),
  docs: [
    sourceRef("Circle xReserve", "https://www.circle.com/xreserve", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Movement USDCx announcement", "https://www.movementnetwork.xyz/article/introducing-usdcx-movements-native-usdc-backed-stablecoin", ["route", "capacity", "access"]),
  ],
  notes: [
    "USDCx exits into tracked Circle USDC through the xReserve contract; final fiat redemption remains Circle's issuer route.",
  ],
};
