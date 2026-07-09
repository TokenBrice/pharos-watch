export const LIVE_RESERVE_SOURCE_MODEL_VALUES = ["dynamic-mix", "validated-static", "single-bucket"] as const;

export const LIVE_RESERVE_EVIDENCE_CLASS_VALUES = ["independent", "static-validated", "weak-live-probe"] as const;

export const LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES = ["none", "source-invariant"] as const;

export const LIVE_RESERVE_WARNING_EFFECT_VALUES = ["info", "degraded", "fatal"] as const;

export const LIVE_RESERVE_FRESHNESS_MODE_VALUES = ["verified", "unverified", "not-applicable"] as const;

export const RESERVE_DISPLAY_BADGE_KIND_VALUES = ["live", "curated-validated", "proof"] as const;

export const LIVE_RESERVE_SEMANTICS_VALUES = [
  "collateral-mix",
  "protocol-reserve",
  "attestation-mix",
  "single-asset",
] as const;

export const LIVE_RESERVE_RPC_MODE_VALUES = ["etherscan-proxy", "alchemy", "public-rpc"] as const;

export type LiveReserveSourceModel = (typeof LIVE_RESERVE_SOURCE_MODEL_VALUES)[number];
export type LiveReserveEvidenceClass = (typeof LIVE_RESERVE_EVIDENCE_CLASS_VALUES)[number];
export type LiveReserveSourceSharingMode = (typeof LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES)[number];
export type LiveReserveWarningEffect = (typeof LIVE_RESERVE_WARNING_EFFECT_VALUES)[number];
export type LiveReserveFreshnessMode = (typeof LIVE_RESERVE_FRESHNESS_MODE_VALUES)[number];
export type ReserveDisplayBadgeKind = (typeof RESERVE_DISPLAY_BADGE_KIND_VALUES)[number];
export type LiveReserveSemantics = (typeof LIVE_RESERVE_SEMANTICS_VALUES)[number];
export type LiveReserveRpcMode = (typeof LIVE_RESERVE_RPC_MODE_VALUES)[number];

export type LiveReserveInput =
  | { kind: "http-json"; url: string }
  | { kind: "http-html"; url: string }
  | { kind: "indexer"; url: string }
  | { kind: "onchain-solana" }
  | { kind: "onchain-evm"; chain: string; rpcMode: LiveReserveRpcMode };

export interface LiveReserveAdapterValidationPolicy {
  maxSourceAgeSec?: number;
  maxUnknownExposurePct?: number;
  allowedFreshnessModes?: LiveReserveFreshnessMode[];
}
