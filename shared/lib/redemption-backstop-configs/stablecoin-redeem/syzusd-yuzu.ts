import { documentedBoundSupplyFull, fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const SYZUSD_YUZU_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  ...documentedBoundSupplyFull(REVIEWED_YIELD_EXPANSION_AT),
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  totalScoreCap: 65,
  costModel: fixedFee(
    0,
    "Yuzu syzUSD ERC-4626 unwrap charges no exit fee: on-chain previewRedeem == convertToAssets (Plasma 0xc8a8df9b210243c55d31c73090f06787ad0a1bf6), no fee selectors; downstream yzUSD primary redemption stays KYC-gated",
  ),
  docs: [
    sourceRef("Yuzu syzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/staked-yzusd-syzusd", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Yuzu yzUSD docs", "https://yuzu-money.gitbook.io/yuzu-money/defi-suite/yuzu-stablecoin-yzusd", ["route", "access"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the wrapper's idle yzUSD balance as current direct unwrap capacity; if the live snapshot is unavailable, the route is left unrated instead of using the prior full-supply model.",
  ],
});
