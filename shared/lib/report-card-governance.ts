import type { BridgeRouteRiskTier } from "../types";

/**
 * Relative strength of a reviewed bridge-route tier (0-100, higher is safer).
 *
 * The Safety Score V8 decentralization blend that consumed this table was
 * deleted with the V8 engine. The ordering survives because `l2beat-audit`
 * resolves the weakest inbound route tier for a chain from it.
 */
export const BRIDGE_ROUTE_RISK_SCORE: Record<BridgeRouteRiskTier, number> = {
  "single-chain-or-native": 100,
  "issuer-native-burn-mint": 90,
  "canonical-rollup-bridge": 85,
  "issuer-native-lock-mint": 80,
  "external-validated-network": 65,
  "liquidity-or-intent-route": 55,
  "external-lock-mint": 40,
  "opaque-or-unknown": 20,
};
