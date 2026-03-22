import { z } from "zod";

const LIVE_RESERVE_ADAPTER_KEYS = [
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
  "reservoir",
  "sgforge-coinvertible",
  "single-asset",
  "sky-makercore",
  "tether",
] as const;

const _LIVE_RESERVE_SOURCE_MODEL_VALUES = [
  "dynamic-mix",
  "validated-static",
  "single-bucket",
] as const;

const _LIVE_RESERVE_EVIDENCE_CLASS_VALUES = [
  "independent",
  "static-validated",
  "weak-live-probe",
] as const;

const _LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES = [
  "none",
  "source-invariant",
] as const;

const _LIVE_RESERVE_WARNING_EFFECT_VALUES = [
  "info",
  "degraded",
  "fatal",
] as const;

const _LIVE_RESERVE_FRESHNESS_MODE_VALUES = [
  "verified",
  "unverified",
  "not-applicable",
] as const;

const LIVE_RESERVE_SEMANTICS_VALUES = [
  "collateral-mix",
  "protocol-reserve",
  "attestation-mix",
  "single-asset",
] as const;

const LIVE_RESERVE_RPC_MODE_VALUES = ["etherscan-proxy", "alchemy", "public-rpc"] as const;
const RESERVE_RISK_VALUES = ["very-low", "low", "medium", "high", "very-high"] as const;
const DEPENDENCY_TYPE_VALUES = ["wrapper", "mechanism", "collateral"] as const;

export type LiveReserveAdapterKey = (typeof LIVE_RESERVE_ADAPTER_KEYS)[number];
export type LiveReserveSourceModel = (typeof _LIVE_RESERVE_SOURCE_MODEL_VALUES)[number];
/** @deprecated Use LiveReserveSourceModel. */
export type LiveReserveFeedClass = LiveReserveSourceModel;
export type LiveReserveEvidenceClass = (typeof _LIVE_RESERVE_EVIDENCE_CLASS_VALUES)[number];
export type LiveReserveSourceSharingMode = (typeof _LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES)[number];
export type LiveReserveWarningEffect = (typeof _LIVE_RESERVE_WARNING_EFFECT_VALUES)[number];
export type LiveReserveFreshnessMode = (typeof _LIVE_RESERVE_FRESHNESS_MODE_VALUES)[number];
export type LiveReserveSemantics = (typeof LIVE_RESERVE_SEMANTICS_VALUES)[number];
export type LiveReserveRisk = (typeof RESERVE_RISK_VALUES)[number];
export type LiveReserveDependencyType = (typeof DEPENDENCY_TYPE_VALUES)[number];
export type LiveReserveInput =
  | { kind: "http-json"; url: string }
  | { kind: "http-html"; url: string }
  | { kind: "indexer"; url: string }
  | { kind: "onchain-evm"; chain: string; rpcMode: (typeof LIVE_RESERVE_RPC_MODE_VALUES)[number] };

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
  supplyUsd?: number;
  totalReserveUsd?: number;
  immediateRedeemableUsd?: number;
  immediateRedeemableRatio?: number;
  redemptionFeeBps?: number;
  details?: Record<string, unknown>;
}

export interface LiveReserveAdapterValidationPolicy {
  maxSourceAgeSec?: number;
  maxUnknownExposurePct?: number;
}

const LiveReserveSemanticsSchema = z.enum(LIVE_RESERVE_SEMANTICS_VALUES);
const LiveReserveRpcModeSchema = z.enum(LIVE_RESERVE_RPC_MODE_VALUES);
const LiveReserveRiskSchema = z.enum(RESERVE_RISK_VALUES);
const LiveReserveDependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);

const LiveReserveInputSchema: z.ZodType<LiveReserveInput> = z.union([
  z.object({
    kind: z.literal("http-json"),
    url: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("http-html"),
    url: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("indexer"),
    url: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("onchain-evm"),
    chain: z.string(),
    rpcMode: LiveReserveRpcModeSchema,
  }).strict(),
]);

const LiveReserveDisplaySchema = z.object({
  url: z.string().optional(),
  label: z.string().optional(),
}).strict();

export interface LiveReserveDisplay {
  url?: string;
  label?: string;
}

const stringRecordSchema = z.record(z.string(), z.string());
const riskRecordSchema = z.record(z.string(), LiveReserveRiskSchema);

const noParamsSchema = z.object({}).strict();

const accountableParamsSchema = z.object({
  bucket: z.enum([
    "type",
    "reserves_split",
    "deployment",
    "type_split",
    "stablecoin_split",
    "exposure_split",
  ]).optional(),
  riskMap: riskRecordSchema.optional(),
  renameMap: stringRecordSchema.optional(),
}).strict();

const btcfiParamsSchema = z.object({
  handlersUrl: z.string(),
}).strict();

const chainlinkNavParamsSchema = z.object({
  oracleAddress: z.string(),
  tokenAddress: z.string(),
  assetLabel: z.string(),
  assetRisk: LiveReserveRiskSchema,
  oracleMethod: z.enum(["latestRoundData", "getPrice"]).optional(),
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  maxOracleAgeSec: z.number().positive().optional(),
}).strict();

const chainlinkPorParamsSchema = z.object({
  porFeedAddress: z.string(),
  assetLabel: z.string(),
  assetRisk: LiveReserveRiskSchema,
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  maxOracleAgeSec: z.number().positive().optional(),
}).strict();

const circleTransparencyParamsSchema = z.object({
  coinType: z.enum(["usdc", "eurc"]),
}).strict();

const collateralPositionsParamsSchema = z.object({
  pricesUrl: z.string(),
  otherThresholdPct: z.number().positive().optional(),
}).strict();

const curatedValidatedParamsSchema = z.object({
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
}).strict();

const reserveSliceDescriptorSchema = z.object({
  name: z.string(),
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
  expectedAssetAddress: z.string().optional(),
}).strict();

const redemptionRateProbeSchema = z.object({
  contract: z.string(),
  selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
  decimals: z.number().int().positive().optional(),
}).strict();

const erc4626SingleAssetParamsSchema = z.object({
  slice: reserveSliceDescriptorSchema,
}).strict();

const evmBranchBalanceBranchSchema = z.object({
  name: z.string(),
  holder: z.string(),
  token: z.object({
    chain: z.string(),
    address: z.string(),
    decimals: z.number().int().nonnegative(),
  }).strict(),
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
  priceUsd: z.number().positive().optional(),
}).strict();

const evmBranchBalancesParamsSchema = z.object({
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  branches: z.array(evmBranchBalanceBranchSchema).min(1),
  redemptionRateProbe: redemptionRateProbeSchema.optional(),
}).strict();

const ghoGsmModuleSchema = z.object({
  address: z.string(),
  label: z.string(),
  coinId: z.string().optional(),
  risk: LiveReserveRiskSchema.optional(),
}).strict();

const ghoParamsSchema = z.object({
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  gsmModules: z.array(ghoGsmModuleSchema).min(1),
}).strict();

const sgForgeCoinvertibleParamsSchema = z.object({
  coinType: z.enum(["eur", "usd"]).optional(),
}).strict();

const singleAssetProbeSchema = z.object({
  kind: z.literal("json-path"),
  path: z.array(z.string()).min(1),
}).strict();

const singleAssetParamsSchema = z.object({
  label: z.string(),
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  probe: singleAssetProbeSchema.optional(),
  redemptionRateProbe: redemptionRateProbeSchema.optional(),
}).strict();

const baseLiveReserveConfigSchema = z.object({
  version: z.number().int().positive(),
  semantics: LiveReserveSemanticsSchema,
  breakerScope: z.string().optional(),
  display: LiveReserveDisplaySchema.optional(),
  inputs: z.object({
    primary: LiveReserveInputSchema,
    fallbacks: z.array(LiveReserveInputSchema).optional(),
  }).strict(),
});

const adapterParamsSchemas = {
  accountable: accountableParamsSchema,
  asymmetry: noParamsSchema,
  btcfi: btcfiParamsSchema,
  "chainlink-nav": chainlinkNavParamsSchema,
  "chainlink-por": chainlinkPorParamsSchema,
  "circle-transparency": circleTransparencyParamsSchema,
  "collateral-positions-api": collateralPositionsParamsSchema,
  crvusd: noParamsSchema,
  "curated-validated": curatedValidatedParamsSchema,
  "dola-inverse": noParamsSchema,
  "erc4626-single-asset": erc4626SingleAssetParamsSchema,
  ethena: noParamsSchema,
  "evm-branch-balances": evmBranchBalancesParamsSchema,
  falcon: noParamsSchema,
  "fdusd-transparency": noParamsSchema,
  frax: noParamsSchema,
  fx: noParamsSchema,
  gho: ghoParamsSchema,
  infinifi: noParamsSchema,
  m0: noParamsSchema,
  mento: noParamsSchema,
  "openeden-usdo": noParamsSchema,
  reservoir: noParamsSchema,
  "sgforge-coinvertible": sgForgeCoinvertibleParamsSchema,
  "single-asset": singleAssetParamsSchema,
  "sky-makercore": noParamsSchema,
  tether: noParamsSchema,
} as const satisfies Record<LiveReserveAdapterKey, z.ZodTypeAny>;

export type LiveReserveAdapterParamsByKey = {
  [K in keyof typeof adapterParamsSchemas]: z.infer<(typeof adapterParamsSchemas)[K]>;
};

export type LiveReserveAdapterParams = LiveReserveAdapterParamsByKey[LiveReserveAdapterKey];

const MATERIAL_UNKNOWN_EXPOSURE_PCT = 5;
const DASHBOARD_SOURCE_MAX_AGE_SEC = 3 * 86400;
const DISCLOSURE_SOURCE_MAX_AGE_SEC = 7 * 86400;

export const LIVE_RESERVE_ADAPTER_DEFINITIONS = {
  accountable: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC },
  },
  asymmetry: { sourceModel: "dynamic-mix", evidenceClass: "independent", sharedSourceMode: "none" },
  btcfi: { sourceModel: "single-bucket", evidenceClass: "independent", sharedSourceMode: "none" },
  "chainlink-nav": { sourceModel: "single-bucket", evidenceClass: "independent", sharedSourceMode: "none" },
  "chainlink-por": { sourceModel: "single-bucket", evidenceClass: "independent", sharedSourceMode: "none" },
  "circle-transparency": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC },
  },
  "collateral-positions-api": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT },
  },
  crvusd: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT },
  },
  "curated-validated": { sourceModel: "validated-static", evidenceClass: "static-validated", sharedSourceMode: "none" },
  "dola-inverse": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC },
  },
  "erc4626-single-asset": { sourceModel: "single-bucket", evidenceClass: "independent", sharedSourceMode: "none" },
  ethena: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
    },
  },
  "evm-branch-balances": { sourceModel: "dynamic-mix", evidenceClass: "independent", sharedSourceMode: "none" },
  falcon: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
    },
  },
  "fdusd-transparency": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC },
  },
  frax: {
    sourceModel: "validated-static",
    evidenceClass: "static-validated",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC },
  },
  fx: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC },
  },
  gho: { sourceModel: "dynamic-mix", evidenceClass: "independent", sharedSourceMode: "none" },
  infinifi: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
    },
  },
  m0: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    validation: { maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC },
  },
  mento: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    validation: { maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC },
  },
  "openeden-usdo": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC },
  },
  reservoir: {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
    },
  },
  "sgforge-coinvertible": {
    sourceModel: "single-bucket",
    evidenceClass: "independent",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC },
  },
  "single-asset": { sourceModel: "single-bucket", evidenceClass: "weak-live-probe", sharedSourceMode: "none" },
  "sky-makercore": {
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    sharedSourceMode: "source-invariant",
    validation: {
      maxSourceAgeSec: DASHBOARD_SOURCE_MAX_AGE_SEC,
      maxUnknownExposurePct: MATERIAL_UNKNOWN_EXPOSURE_PCT,
    },
  },
  tether: {
    sourceModel: "single-bucket",
    evidenceClass: "weak-live-probe",
    sharedSourceMode: "none",
    validation: { maxSourceAgeSec: DISCLOSURE_SOURCE_MAX_AGE_SEC },
  },
} as const satisfies Record<LiveReserveAdapterKey, {
  sourceModel: LiveReserveSourceModel;
  evidenceClass: LiveReserveEvidenceClass;
  sharedSourceMode: LiveReserveSourceSharingMode;
  validation?: LiveReserveAdapterValidationPolicy;
}>;

const liveReserveConfigVariants = LIVE_RESERVE_ADAPTER_KEYS.map((adapterKey) =>
  baseLiveReserveConfigSchema.extend({
    adapter: z.literal(adapterKey),
    params: adapterParamsSchemas[adapterKey].optional(),
  }),
) as unknown as readonly [z.ZodTypeAny, ...z.ZodTypeAny[]];

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

export const LiveReservesConfigSchema: z.ZodType<LiveReservesConfig> = z.union(
  liveReserveConfigVariants as unknown as [z.ZodType<LiveReservesConfig>, ...z.ZodType<LiveReservesConfig>[]],
);

export function getLiveReserveAdapterDefinition(
  adapterKey: LiveReserveAdapterKey,
): (typeof LIVE_RESERVE_ADAPTER_DEFINITIONS)[LiveReserveAdapterKey] {
  return LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
}

export function parseLiveReserveAdapterParams<K extends LiveReserveAdapterKey>(
  adapterKey: K,
  params: Record<string, unknown> | undefined,
): LiveReserveAdapterParamsByKey[K] {
  const schema = adapterParamsSchemas[adapterKey] as unknown as z.ZodType<LiveReserveAdapterParamsByKey[K]>;
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) {
    return parsed.data;
  }

  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? `.${issue.path.join(".")}` : "";
  throw new Error(`${adapterKey} adapter params invalid${path}: ${issue?.message ?? "unknown validation error"}`);
}
