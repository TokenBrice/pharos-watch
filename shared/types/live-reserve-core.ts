import { z } from "zod";
import { StrictIsoDateSchema } from "./safety-schema-primitives";
import { isValidIsoDateOnly } from "./date-primitives";

const ADAPTER_KEYS = [
  "spark-usdc-v1-inventory",
  "forest-road-reserve-manager",
  "leverup-lvusd",
  "hylo-solana",
  "3jane-usd3",
  "anchorage-independent-assurance",
  "accountable",
  "agora-independent-assurance",
  "axis-issuer-classes",
  "anzen-usdz",
  "moc-doc",
  "moc-v3-buckets",
  "astherus-earn-wrapper",
  "attestation-pdf-index",
  "myrc-independent-assurance",
  "audd-independent-assurance",
  "audx-independent-assurance",
  "blast-usdb-yield-manager",
  "brla-independent-assurance",
  "cadd-independent-assurance",
  "bridge-transparency",
  "btcfi",
  "cap-vault",
  "chainlink-nav",
  "jpmorgan-nav",
  "ondo-usdy",
  "ondo-ousg",
  "midas-mtbill",
  "chronicle-nav",
  "chainlink-por",
  "circle-transparency",
  "collateral-positions-api",
  "crvusd",
  "curated-validated",
  "theo-thusd-redemption",
  "usdai-hub",
  "dola-inverse",
  "erc4626-single-asset",
  "escrow-balance",
  "ethena",
  "ethena-whitelabel",
  "evm-branch-balances",
  "parallelizer-balances",
  "europ-independent-assurance",
  "xdai-bridge",
  "xpr-account-balances",
  "falcon",
  "fdusd-independent-assurance",
  "fidd-independent-assurance",
  "flying-tulip-ftusd",
  "frax-balance-sheet",
  "frax-fpi-collateral",
  "fx",
  "gemini-independent-assurance",
  "sodax-sonic",
  "gho",
  "hive-hbd-protocol",
  "idle-cdo-epoch-variant",
  "infinifi",
  "initia-wrapper-vault",
  "issuer-attested-report",
  "jupusd",
  "kava-cdp",
  "hliquity-hedera",
  "kerne-signed-por",
  "krwq-custodian",
  "liquity-v1",
  "liquity-native-active-pool",
  "liquity-v2-branches",
  "m0",
  "m0-wrapper-underlying",
  "m0-solana-wrapper",
  "makina-strategy",
  "megausd-custody",
  "megausd-custody-onchain",
  "mento",
  "money-llamma",
  "monolith-lender",
  "nest-vault-positions",
  "origin-vault-balances",
  "quantoz-transparency",
  "re-metrics",
  "resupply-pairs",
  "reserve-protocol-dtf",
  "reservoir",
  "rlusd-independent-assurance",
  "sgforge-coinvertible",
  "saturn-pyusdx",
  "sbc-independent-assurance",
  "solstice-attestation",
  "single-asset",
  "sky-makercore",
  "solomon-chancery",
  "spiko-api",
  "superstate-liquidity",
  "paxos-independent-assurance",
  "straitsx-independent-assurance",
  "river-protocol-info",
  "tether-transparency",
  "tether-transparency-mxnt",
  "united-por",
  "usdgo-transparency",
  "usdai-proof-of-reserves",
  "usd1-bundle-oracle",
  "usdd-data-platform",
  "usdtb-transparency",
  "yamato",
  "youves-tezos",
  "zephyr-scanner",
  "djed-cardano",
  "dgld-gold-mapper",
  "matrixdock-frs",
  "icp-gldt",
  "onre-holdings-csv",
  "avant-reserves-api",
  "afi-proof",
  "frnt-ledgerlens",
  "coinbase-oned-por",
  "blackrock-brsrv-holdings",
  "chinaamc-holdings-api",
] as const;

export type LiveReserveAdapterKey = (typeof ADAPTER_KEYS)[number];

/** Stable wire vocabulary and registration order, independent of operational schemas. */
export const LIVE_RESERVE_ADAPTER_KEYS: readonly LiveReserveAdapterKey[] = Object.freeze(ADAPTER_KEYS);

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
