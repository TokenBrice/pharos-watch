import { fixedFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_FXSAVE_LIVE_REDEMPTION_AT } from "./shared";

export const FXSAVE_F_X_PROTOCOL_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: fixedFee(
    100,
    "f(x) atomic fxSAVE exits route through fxSP instantRedeem, where the current on-chain instantRedeemFeeRatio is 1%; the admin-governed parameter is capped at 5%",
  ),
  reviewedAt: REVIEWED_FXSAVE_LIVE_REDEMPTION_AT,
  docs: [
    sourceRef("f(x) Stability Pool", "https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/stability-pool", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Integrating fxSAVE", "https://fxprotocol.gitbook.io/fx-docs/developers/integrating-fxsave", ["route", "fees", "access", "settlement"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the fxSAVE vault's idle fxSP balance as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of falling back to the prior heuristic strategy-buffer estimate.",
  ],
});
