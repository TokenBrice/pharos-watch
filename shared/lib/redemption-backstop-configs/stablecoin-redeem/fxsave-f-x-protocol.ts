import {
  documentedVariableFee,
  type RedemptionBackstopConfig,
  sourceRef,
  stablecoinRedeemBase,
} from "../shared";
import { REVIEWED_YIELD_EXPANSION_AT } from "./shared";

export const FXSAVE_F_X_PROTOCOL_STABLECOIN_REDEEM_CONFIG: RedemptionBackstopConfig = {
  ...stablecoinRedeemBase,
  capacityModel: { kind: "supply-ratio", ratio: 0.2, confidence: "heuristic", basis: "strategy-buffer" },
  executionModel: "rules-based-nav",
  costModel: documentedVariableFee("fxSAVE can exit through fxSP/router routes into fxUSD, USDC, or both depending on available liquidity"),
  reviewedAt: REVIEWED_YIELD_EXPANSION_AT,
  docs: [
    sourceRef("f(x) Stability Pool", "https://fxprotocol.gitbook.io/fx-docs/f-x-protocol-mechanisms/stability-pool", ["route", "capacity", "fees", "access", "settlement"]),
    sourceRef("Integrating fxSAVE", "https://fxprotocol.gitbook.io/fx-docs/developers/integrating-fxsave", ["route"]),
  ],
};
