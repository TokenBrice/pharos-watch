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

const _LIVE_RESERVE_FEED_CLASS_VALUES = [
  "dynamic-mix",
  "validated-static",
  "single-bucket",
] as const;

const _LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES = [
  "none",
  "source-invariant",
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
export type LiveReserveFeedClass = (typeof _LIVE_RESERVE_FEED_CLASS_VALUES)[number];
export type LiveReserveSourceSharingMode = (typeof _LIVE_RESERVE_SHARED_SOURCE_MODE_VALUES)[number];
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
}).strict();

const reserveSliceDescriptorSchema = z.object({
  name: z.string(),
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
  expectedAssetAddress: z.string().optional(),
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
}).strict();

const ghoParamsSchema = z.object({
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
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

export const LIVE_RESERVE_ADAPTER_DEFINITIONS = {
  accountable: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  asymmetry: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  btcfi: { feedClass: "single-bucket", sharedSourceMode: "none" },
  "chainlink-nav": { feedClass: "single-bucket", sharedSourceMode: "none" },
  "chainlink-por": { feedClass: "single-bucket", sharedSourceMode: "none" },
  "circle-transparency": { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  "collateral-positions-api": { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  crvusd: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  "curated-validated": { feedClass: "validated-static", sharedSourceMode: "none" },
  "dola-inverse": { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  "erc4626-single-asset": { feedClass: "single-bucket", sharedSourceMode: "none" },
  ethena: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  "evm-branch-balances": { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  falcon: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  "fdusd-transparency": { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  frax: { feedClass: "validated-static", sharedSourceMode: "none" },
  fx: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  gho: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  infinifi: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  m0: { feedClass: "dynamic-mix", sharedSourceMode: "source-invariant" },
  mento: { feedClass: "dynamic-mix", sharedSourceMode: "source-invariant" },
  "openeden-usdo": { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  reservoir: { feedClass: "dynamic-mix", sharedSourceMode: "none" },
  "sgforge-coinvertible": { feedClass: "single-bucket", sharedSourceMode: "none" },
  "single-asset": { feedClass: "single-bucket", sharedSourceMode: "none" },
  "sky-makercore": { feedClass: "dynamic-mix", sharedSourceMode: "source-invariant" },
  tether: { feedClass: "single-bucket", sharedSourceMode: "none" },
} as const satisfies Record<LiveReserveAdapterKey, {
  feedClass: LiveReserveFeedClass;
  sharedSourceMode: LiveReserveSourceSharingMode;
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
