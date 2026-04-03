import type { DependencyType } from "./dependency-types";
import type { ReserveSlice } from "./reserves";

export const LIVE_RESERVE_ADAPTER_KEYS = [
  "accountable",
  "asymmetry",
  "btcfi",
  "chainlink-nav",
  "chainlink-por",
  "circle-transparency",
  "collateral-positions-api",
  "crvusd",
  "curated-validated",
  "dola-inverse",
  "erc4626-single-asset",
  "ethena",
  "evm-branch-balances",
  "falcon",
  "fdusd-transparency",
  "frax",
  "fx",
  "gho",
  "infinifi",
  "m0",
  "mento",
  "openeden-usdo",
  "re-metrics",
  "reservoir",
  "sgforge-coinvertible",
  "single-asset",
  "sky-makercore",
  "tether",
  "usdd-data-platform",
] as const;

export const LIVE_RESERVE_SOURCE_MODEL_VALUES = [
  "dynamic-mix",
  "validated-static",
  "single-bucket",
] as const;

export const LIVE_RESERVE_EVIDENCE_CLASS_VALUES = [
  "independent",
  "static-validated",
  "weak-live-probe",
] as const;

export const LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES = [
  "none",
  "source-invariant",
] as const;

export const LIVE_RESERVE_WARNING_EFFECT_VALUES = [
  "info",
  "degraded",
  "fatal",
] as const;

export const LIVE_RESERVE_FRESHNESS_MODE_VALUES = [
  "verified",
  "unverified",
  "not-applicable",
] as const;

export const LIVE_RESERVE_SEMANTICS_VALUES = [
  "collateral-mix",
  "protocol-reserve",
  "attestation-mix",
  "single-asset",
] as const;

export const LIVE_RESERVE_RPC_MODE_VALUES = ["etherscan-proxy", "alchemy", "public-rpc"] as const;
export const LIVE_RESERVE_RISK_VALUES = ["very-low", "low", "medium", "high", "very-high"] as const;

export type LiveReserveAdapterKey = (typeof LIVE_RESERVE_ADAPTER_KEYS)[number];
export type LiveReserveSourceModel = (typeof LIVE_RESERVE_SOURCE_MODEL_VALUES)[number];
/** @deprecated Use LiveReserveSourceModel. */
export type LiveReserveFeedClass = LiveReserveSourceModel;
export type LiveReserveEvidenceClass = (typeof LIVE_RESERVE_EVIDENCE_CLASS_VALUES)[number];
export type LiveReserveSourceSharingMode = (typeof LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES)[number];
export type LiveReserveWarningEffect = (typeof LIVE_RESERVE_WARNING_EFFECT_VALUES)[number];
export type LiveReserveFreshnessMode = (typeof LIVE_RESERVE_FRESHNESS_MODE_VALUES)[number];
export type LiveReserveSemantics = (typeof LIVE_RESERVE_SEMANTICS_VALUES)[number];
export type LiveReserveRisk = (typeof LIVE_RESERVE_RISK_VALUES)[number];
export type LiveReserveRpcMode = (typeof LIVE_RESERVE_RPC_MODE_VALUES)[number];
export type LiveReserveDependencyType = DependencyType;

export type LiveReserveInput =
  | { kind: "http-json"; url: string }
  | { kind: "http-html"; url: string }
  | { kind: "indexer"; url: string }
  | { kind: "onchain-evm"; chain: string; rpcMode: LiveReserveRpcMode };

export interface LiveReserveWarning {
  code: string;
  message: string;
  severity: "info" | "warning";
  effect: LiveReserveWarningEffect;
}

export interface LiveReserveSnapshotMetadata extends Record<string, unknown> {
  sourceTimestamp?: number;
  freshnessMode?: LiveReserveFreshnessMode;
  unknownExposurePct?: number;
  yieldBasisCollateralUsd?: number;
  yieldBasisCollateralPct?: number;
  supplyUsd?: number;
  totalReserveUsd?: number;
  totalAssetsUsd?: number;
  totalLiabilitiesUsd?: number;
  shareholderEquityUsd?: number;
  collateralizationRatio?: number;
  immediateRedeemableUsd?: number;
  immediateRedeemableRatio?: number;
  redemptionFeeBps?: number;
  buyFeeBpsMin?: number;
  buyFeeBpsMax?: number;
  details?: Record<string, unknown>;
}

export interface LiveReserveAdapterValidationPolicy {
  maxSourceAgeSec?: number;
  maxUnknownExposurePct?: number;
  allowedFreshnessModes?: LiveReserveFreshnessMode[];
}

export interface LiveReserveDisplay {
  url?: string;
  label?: string;
}

export interface LiveReservesConfig {
  adapter: LiveReserveAdapterKey;
  version: number;
  semantics: LiveReserveSemantics;
  breakerScope?: string;
  display?: LiveReserveDisplay;
  inputs: {
    primary: LiveReserveInput;
    fallbacks?: LiveReserveInput[];
  };
  params?: Record<string, unknown>;
}

export type ReservePresentationMode =
  | "live"
  | "live-stale"
  | "curated-fallback"
  | "template-fallback"
  | "unavailable";

export interface ReserveSyncStateView {
  enabled: boolean;
  status: "ok" | "degraded" | "error" | "skipped";
  stale: boolean;
  bootstrap: boolean;
  lastAttemptedAt?: number;
  lastSuccessAt?: number;
  warnings?: string[];
  lastError?: string;
}

export interface ReserveProvenanceView {
  evidenceClass: LiveReserveEvidenceClass;
  sourceModel: LiveReserveSourceModel;
  freshnessMode?: LiveReserveFreshnessMode;
  scoringEligible: boolean;
}

export interface StablecoinReservesResponse {
  stablecoinId: string;
  mode: ReservePresentationMode;
  reserves: ReserveSlice[];
  estimated: boolean;
  liveAt?: number;
  source?: string;
  displayUrl?: string;
  metadata?: LiveReserveSnapshotMetadata;
  provenance?: ReserveProvenanceView;
  sync?: ReserveSyncStateView;
}
