import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_FXSAVE_LIVE_REDEMPTION_AT } from "./shared";

export const FXSAVE_F_X_PROTOCOL_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "reserve-sync-metadata" },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("fxSAVE can exit through fxSP/router routes into fxUSD, USDC, or both depending on available liquidity"),
  reviewedAt: REVIEWED_FXSAVE_LIVE_REDEMPTION_AT,
  docs: [
    sourceRef("f(x) Stability Pool", "https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/stability-pool", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Integrating fxSAVE", "https://fxprotocol.gitbook.io/fx-docs/developers/integrating-fxsave", ["route", "fees", "access", "settlement"]),
  ],
  notes: [
    "Fresh ERC-4626 reserve telemetry reads the fxSAVE vault's idle fxSP balance as current direct redemption capacity; if the live snapshot is unavailable, the route is left unrated instead of falling back to the prior heuristic strategy-buffer estimate.",
  ],
};
