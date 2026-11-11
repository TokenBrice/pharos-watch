import { z } from "zod";

export const BRIDGE_ROUTE_RISK_TIER_VALUES = [
  "single-chain-or-native",
  "issuer-native-burn-mint",
  "canonical-rollup-bridge",
  "issuer-native-lock-mint",
  "external-validated-network",
  "liquidity-or-intent-route",
  "external-lock-mint",
  "opaque-or-unknown",
] as const;
export type BridgeRouteRiskTier = (typeof BRIDGE_ROUTE_RISK_TIER_VALUES)[number];

export const BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES = ["verified", "probable", "manual-review", "unknown"] as const;
export type BridgeRouteRiskConfidence = (typeof BRIDGE_ROUTE_RISK_CONFIDENCE_VALUES)[number];

export const BRIDGE_ROUTE_RISK_SOURCE_VALUES = ["l2beat", "issuer", "docs", "explorer", "manual"] as const;

export const BRIDGE_ROUTE_CLASS_VALUES = ["native", "canonical", "third-party", "unknown"] as const;
export const BRIDGE_ROUTE_REVIEW_DISPOSITION_VALUES = ["reviewed", "unresolved"] as const;
export const BRIDGE_ROUTE_ISSUANCE_MODEL_VALUES = [
  "native-issuance",
  "bridge-representation",
  "wrapped-representation",
  "liquidity-settlement",
  "unknown",
] as const;
export const BRIDGE_ROUTE_SEMANTICS_VALUES = [
  "native-mint",
  "burn-mint",
  "lock-mint",
  "liquidity",
  "intent",
  "other",
  "unknown",
] as const;
export const BRIDGE_ROUTE_SCOPE_VALUES = ["global", "canonical", "peripheral", "unknown"] as const;
export type BridgeRouteScope = (typeof BRIDGE_ROUTE_SCOPE_VALUES)[number];

export const BRIDGE_ROUTE_CONTROL_CAPABILITY_VALUES = [
  "bridge-mint",
  "bridge-burn",
  "upgrade",
  "admin",
  "pause",
  "rate-limit",
  "validator",
  "escrow",
  "peer-config",
] as const;
export type BridgeRouteControlCapability = (typeof BRIDGE_ROUTE_CONTROL_CAPABILITY_VALUES)[number];
export const BridgeRouteRiskTierSchema = z.enum(BRIDGE_ROUTE_RISK_TIER_VALUES);
