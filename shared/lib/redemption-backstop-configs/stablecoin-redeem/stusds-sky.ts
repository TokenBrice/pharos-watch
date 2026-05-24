import {
  documentedBoundSupplyFull,
  undisclosedReviewedFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_STABLECOIN_AUDIT_AT } from "./shared";

export const STUSDS_SKY_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_STABLECOIN_AUDIT_AT),
  executionModel: "rules-based-nav",
  costModel: undisclosedReviewedFee(),
  docs: [
    sourceRef("Sky stUSDS docs", "https://developers.skyeco.com/protocol/tokens/stusds/", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Sky protocol token routes", "https://developers.sky.money/quick-start/protocol-token-routes/", ["route", "capacity"]),
  ],
  notes: [
    "stUSDS is an ERC-4626 risk-capital wrapper over USDS: holders can deposit USDS to receive stUSDS or withdraw USDS with their stUSDS balance.",
    "The wrapper leg exits into USDS; downstream USDS par-exit quality remains governed by Sky's PSM route, while stUSDS holder value can reflect module liquidity and slashing risk.",
  ],
};
