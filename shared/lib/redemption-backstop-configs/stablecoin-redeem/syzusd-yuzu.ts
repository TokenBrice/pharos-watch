import {
  documentedBoundSupplyFull,
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const SYZUSD_YUZU_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
  executionModel: "rules-based-nav",
  totalScoreCap: 65,
  costModel: documentedVariableFee("syzUSD unwraps to yzUSD; final yzUSD primary redemption is KYC-gated through Yuzu rails"),
  docs: [
    sourceRef("Yuzu syzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/staked-yzusd-syzusd", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Yuzu yzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/yuzu-stablecoin-yzusd", ["route", "access"]),
  ],
};
