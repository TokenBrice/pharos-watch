import { z } from "zod";
import type { DependencyType } from "./dependency-types";
import {
  RESERVE_RISK_VALUES,
  ReserveSliceSchema,
  type ReserveRisk,
  type ReserveSlice,
} from "./reserves";
import {
  RedemptionRouteStatusSchema,
  RedemptionRouteStatusSourceSchema,
} from "./redemption";

export const LIVE_RESERVE_ADAPTER_KEYS = [
  "abracadabra",
  "accountable",
  "anzen-usdz",
  "asymmetry",
  "btcfi",
  "buck-io-transparency",
  "cap-vault",
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
  "frax-balance-sheet",
  "fx",
  "gho",
  "infinifi",
  "jupusd",
  "lista",
  "liquity-v1",
  "liquity-v2-branches",
  "m0",
  "mento",
  "openeden-usdo",
  "re-metrics",
  "reservoir",
  "sgforge-coinvertible",
  "solstice-attestation",
  "single-asset",
  "sky-makercore",
  "superstate-liquidity",
  "tether",
  "river-protocol-info",
  "usdgo-transparency",
  "usdh-native-markets",
  "usdai-proof-of-reserves",
  "usd1-bundle-oracle",
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

export const LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES = [
  "live-direct",
  "live-direct-bounded",
  "live-queue",
  "live-proxy-validated",
  "documented-bound",
  "documented-eventual",
  "heuristic",
] as const;

export const LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES = [
  "verified-source-timestamp",
  "same-run-onchain",
  "same-run-api",
  "reviewed-static",
  "unverified",
] as const;

export const LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES =
  RedemptionRouteStatusSchema.options;

export const LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES =
  RedemptionRouteStatusSourceSchema.options;

export const RESERVE_DISPLAY_BADGE_KIND_VALUES = [
  "live",
  "curated-validated",
  "proof",
] as const;

export const LIVE_RESERVE_SEMANTICS_VALUES = [
  "collateral-mix",
  "protocol-reserve",
  "attestation-mix",
  "single-asset",
] as const;

export const LIVE_RESERVE_RPC_MODE_VALUES = ["etherscan-proxy", "alchemy", "public-rpc"] as const;
export const LIVE_RESERVE_RISK_VALUES = RESERVE_RISK_VALUES;

export type LiveReserveAdapterKey = (typeof LIVE_RESERVE_ADAPTER_KEYS)[number];
export type LiveReserveSourceModel = (typeof LIVE_RESERVE_SOURCE_MODEL_VALUES)[number];
/** @deprecated Use LiveReserveSourceModel. */
export type LiveReserveFeedClass = LiveReserveSourceModel;
export type LiveReserveEvidenceClass = (typeof LIVE_RESERVE_EVIDENCE_CLASS_VALUES)[number];
export type LiveReserveSourceSharingMode = (typeof LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES)[number];
export type LiveReserveWarningEffect = (typeof LIVE_RESERVE_WARNING_EFFECT_VALUES)[number];
export type LiveReserveFreshnessMode = (typeof LIVE_RESERVE_FRESHNESS_MODE_VALUES)[number];
export type LiveReserveRedemptionCapacityKind = (typeof LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES)[number];
export type LiveReserveRedemptionFreshnessKind = (typeof LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES)[number];
export type LiveReserveRedemptionRouteStatus = (typeof LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_VALUES)[number];
export type LiveReserveRedemptionRouteStatusSource = (typeof LIVE_RESERVE_REDEMPTION_ROUTE_STATUS_SOURCE_VALUES)[number];
export type ReserveDisplayBadgeKind = (typeof RESERVE_DISPLAY_BADGE_KIND_VALUES)[number];
export type LiveReserveSemantics = (typeof LIVE_RESERVE_SEMANTICS_VALUES)[number];
export type LiveReserveRisk = ReserveRisk;
export type LiveReserveRpcMode = (typeof LIVE_RESERVE_RPC_MODE_VALUES)[number];
export type LiveReserveDependencyType = DependencyType;

export type LiveReserveInput =
  | { kind: "http-json"; url: string }
  | { kind: "http-html"; url: string }
  | { kind: "indexer"; url: string }
  | { kind: "onchain-solana" }
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
  redemption?: LiveReserveRedemptionTelemetry;
  details?: Record<string, unknown>;
}

export interface LiveReserveRedemptionTelemetry extends Record<string, unknown> {
  capacityUsd?: number;
  capacityRatioOfSupply?: number;
  capacityKind?: LiveReserveRedemptionCapacityKind;
  freshnessKind?: LiveReserveRedemptionFreshnessKind;
  sourceTimestamp?: number;
  blockNumber?: number;
  routeStatus?: LiveReserveRedemptionRouteStatus;
  routeStatusSource?: LiveReserveRedemptionRouteStatusSource;
  routeStatusReason?: string;
  routeStatusReviewedAt?: string;
  holderEligibility?: string;
  settlementDelaySec?: number;
  queueDepthUsd?: number;
  dailyLimitUsd?: number;
  minRedeemUsd?: number;
  feeBps?: number;
  sourceUrls?: string[];
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

export interface ReserveDisplayBadgeView {
  kind: ReserveDisplayBadgeKind;
  label: string;
}

export interface StablecoinReservesResponse {
  stablecoinId: string;
  mode: ReservePresentationMode;
  reserves: ReserveSlice[];
  estimated: boolean;
  liveAt?: number;
  source?: string;
  displayUrl?: string;
  evidenceUrls?: string[];
  metadata?: LiveReserveSnapshotMetadata;
  provenance?: ReserveProvenanceView;
  displayBadge?: ReserveDisplayBadgeView;
  sync?: ReserveSyncStateView;
}

const UnknownRecordSchema: z.ZodType<Record<string, unknown>> = z.record(z.string(), z.unknown());

export const LiveReserveRedemptionTelemetrySchema: z.ZodType<LiveReserveRedemptionTelemetry> = z.object({
  capacityUsd: z.number().finite().optional(),
  capacityRatioOfSupply: z.number().finite().optional(),
  capacityKind: z.enum(LIVE_RESERVE_REDEMPTION_CAPACITY_KIND_VALUES).optional(),
  freshnessKind: z.enum(LIVE_RESERVE_REDEMPTION_FRESHNESS_KIND_VALUES).optional(),
  sourceTimestamp: z.number().finite().optional(),
  blockNumber: z.number().finite().optional(),
  routeStatus: RedemptionRouteStatusSchema.optional(),
  routeStatusSource: RedemptionRouteStatusSourceSchema.optional(),
  routeStatusReason: z.string().optional(),
  routeStatusReviewedAt: z.string().optional(),
  holderEligibility: z.string().optional(),
  settlementDelaySec: z.number().finite().optional(),
  queueDepthUsd: z.number().finite().optional(),
  dailyLimitUsd: z.number().finite().optional(),
  minRedeemUsd: z.number().finite().optional(),
  feeBps: z.number().finite().optional(),
  sourceUrls: z.array(z.string()).optional(),
}).passthrough();

export const LiveReserveSnapshotMetadataSchema: z.ZodType<LiveReserveSnapshotMetadata> = z.object({
  sourceTimestamp: z.number().finite().optional(),
  freshnessMode: z.enum(LIVE_RESERVE_FRESHNESS_MODE_VALUES).optional(),
  unknownExposurePct: z.number().finite().optional(),
  yieldBasisCollateralUsd: z.number().finite().optional(),
  yieldBasisCollateralPct: z.number().finite().optional(),
  supplyUsd: z.number().finite().optional(),
  totalReserveUsd: z.number().finite().optional(),
  totalAssetsUsd: z.number().finite().optional(),
  totalLiabilitiesUsd: z.number().finite().optional(),
  shareholderEquityUsd: z.number().finite().optional(),
  collateralizationRatio: z.number().finite().optional(),
  immediateRedeemableUsd: z.number().finite().optional(),
  immediateRedeemableRatio: z.number().finite().optional(),
  redemptionFeeBps: z.number().finite().optional(),
  buyFeeBpsMin: z.number().finite().optional(),
  buyFeeBpsMax: z.number().finite().optional(),
  redemption: LiveReserveRedemptionTelemetrySchema.optional(),
  details: UnknownRecordSchema.optional(),
}).passthrough();

export const ReserveProvenanceViewSchema: z.ZodType<ReserveProvenanceView> = z.object({
  evidenceClass: z.enum(LIVE_RESERVE_EVIDENCE_CLASS_VALUES),
  sourceModel: z.enum(LIVE_RESERVE_SOURCE_MODEL_VALUES),
  freshnessMode: z.enum(LIVE_RESERVE_FRESHNESS_MODE_VALUES).optional(),
  scoringEligible: z.boolean(),
}).strict();

export const ReserveDisplayBadgeViewSchema: z.ZodType<ReserveDisplayBadgeView> = z.object({
  kind: z.enum(RESERVE_DISPLAY_BADGE_KIND_VALUES),
  label: z.string(),
}).strict();

export const ReserveSyncStateViewSchema: z.ZodType<ReserveSyncStateView> = z.object({
  enabled: z.boolean(),
  status: z.enum(["ok", "degraded", "error", "skipped"]),
  stale: z.boolean(),
  bootstrap: z.boolean(),
  lastAttemptedAt: z.number().finite().optional(),
  lastSuccessAt: z.number().finite().optional(),
  warnings: z.array(z.string()).optional(),
  lastError: z.string().optional(),
}).strict();

export const StablecoinReservesResponseSchema: z.ZodType<StablecoinReservesResponse> = z.object({
  stablecoinId: z.string(),
  mode: z.enum(["live", "live-stale", "curated-fallback", "template-fallback", "unavailable"]),
  reserves: z.array(ReserveSliceSchema),
  estimated: z.boolean(),
  liveAt: z.number().finite().optional(),
  source: z.string().optional(),
  displayUrl: z.string().optional(),
  evidenceUrls: z.array(z.string()).optional(),
  metadata: LiveReserveSnapshotMetadataSchema.optional(),
  provenance: ReserveProvenanceViewSchema.optional(),
  displayBadge: ReserveDisplayBadgeViewSchema.optional(),
  sync: ReserveSyncStateViewSchema.optional(),
}).strict();
