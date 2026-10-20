import { z } from "zod";
import { StrictIsoDateSchema } from "./safety-schema-primitives";
import { isValidIsoDateOnly } from "./date-primitives";

/** Reviewed native denominations; a nominal relation is not custody assurance. */
export const NativeReserveQuantityBasisSchema = /* @__PURE__ */ (() => z.object({
  reserveUnit: z.object({
    kind: z.enum(["currency", "token"]),
    unit: z.string().min(1),
  }).strict(),
  supplyToken: z.string().min(1),
  nominalValuePerToken: z.number().finite().positive().optional(),
  reviewedAt: StrictIsoDateSchema,
  evidenceRef: z.string().min(1),
}).strict())();
export type NativeReserveQuantityBasis = z.output<typeof NativeReserveQuantityBasisSchema>;

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

const AbsoluteUrlSchema = /* @__PURE__ */ (() => z.string().url())();
const LiveReserveRpcModeSchema = /* @__PURE__ */ (() => z.enum(LIVE_RESERVE_RPC_MODE_VALUES))();
const LiveReserveSemanticsSchema = /* @__PURE__ */ (() => z.enum(LIVE_RESERVE_SEMANTICS_VALUES))();

export const LiveReserveInputSchemaByKind = /* @__PURE__ */ (() => ({
  "http-json": z.object({ kind: z.literal("http-json"), url: AbsoluteUrlSchema }).strict(),
  "http-html": z.object({ kind: z.literal("http-html"), url: AbsoluteUrlSchema }).strict(),
  indexer: z.object({ kind: z.literal("indexer"), url: AbsoluteUrlSchema }).strict(),
  "onchain-solana": z.object({ kind: z.literal("onchain-solana") }).strict(),
  "onchain-evm": z
    .object({
      kind: z.literal("onchain-evm"),
      chain: z.string(),
      rpcMode: LiveReserveRpcModeSchema,
    })
    .strict(),
} as const))();
export type LiveReserveInput = z.output<(typeof LiveReserveInputSchemaByKind)[keyof typeof LiveReserveInputSchemaByKind]>;

const LiveReserveDisplaySchema = /* @__PURE__ */ (() => z
  .object({
    url: AbsoluteUrlSchema.optional(),
    label: z.string().optional(),
  })
  .strict())();

const liveReserveScoringPolicySchema = /* @__PURE__ */ (() => z
  .object({
    maxSourceAgeSec: z.number().positive().optional(),
    allowedDegradedWarningCodes: z.array(z.string().min(1)).optional(),
  })
  .strict())();

export const baseLiveReserveConfigSchema = /* @__PURE__ */ (() => z.object({
  version: z.number().int().positive(),
  semantics: LiveReserveSemanticsSchema,
  breakerScope: z.string().min(1).optional(),
  display: LiveReserveDisplaySchema.optional(),
  scoring: liveReserveScoringPolicySchema.optional(),
  /** One bounded reserve-only prerequisite attempt; never authorizes listing. */
  bootstrapForSupplyAdmission: z.object({
    reviewBy: z.string().refine(isValidIsoDateOnly, "reviewBy must be a valid ISO calendar date"),
  }).strict().optional(),
  // Registry loading strips suspended feeds; retain the full authoring config
  // and legacy format-only suspension dates without tightening admission here.
  suspended: z
    .object({
      reason: z.string().min(1),
      since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "since must be an ISO date (YYYY-MM-DD)"),
      reviewBy: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "reviewBy must be an ISO date (YYYY-MM-DD)").optional(),
    })
    .strict()
    .optional(),
}))();
export type BaseLiveReserveConfig = z.output<typeof baseLiveReserveConfigSchema>;

export interface LiveReserveAdapterValidationPolicy {
  maxSourceAgeSec?: number;
  maxUnknownExposurePct?: number;
  allowedFreshnessModes?: LiveReserveFreshnessMode[];
}
