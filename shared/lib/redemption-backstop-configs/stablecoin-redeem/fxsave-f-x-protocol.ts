import { documentedVariableFee, sourceRef } from "../shared";
import { defineStablecoinRedeemConfig, REVIEWED_FXSAVE_LIVE_REDEMPTION_AT } from "./shared";

export const FXSAVE_F_X_PROTOCOL_STABLECOIN_REDEEM_CONFIG = defineStablecoinRedeemConfig({
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee(
    "f(x) fxSP instantRedeem fee = on-chain instantRedeemFeeRatio, currently 1%, governance cap 5%",
    "formula",
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
