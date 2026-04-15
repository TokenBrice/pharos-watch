import { z } from "zod";
import { DAY_SECONDS } from "./time-constants";
import { DEPENDENCY_TYPE_VALUES } from "../types/dependency-types";
import {
  LIVE_RESERVE_RPC_MODE_VALUES,
  LIVE_RESERVE_RISK_VALUES,
  LIVE_RESERVE_SEMANTICS_VALUES,
  type LiveReserveAdapterKey,
  type LiveReserveAdapterValidationPolicy,
  type LiveReserveInput,
} from "../types/live-reserves";

const LiveReserveSemanticsSchema = z.enum(LIVE_RESERVE_SEMANTICS_VALUES);
const LiveReserveRpcModeSchema = z.enum(LIVE_RESERVE_RPC_MODE_VALUES);
const LiveReserveRiskSchema = z.enum(LIVE_RESERVE_RISK_VALUES);
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
    kind: z.literal("onchain-solana"),
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

const stringRecordSchema = z.record(z.string(), z.string());
const riskRecordSchema = z.record(z.string(), LiveReserveRiskSchema);

const noParamsSchema = z.object({}).strict();

const usd1BundleOracleParamsSchema = z.object({
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
}).strict();

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
  oracleMethod: z.enum(["latestRoundData", "getPrice", "getAssetPrice"]).optional(),
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  maxOracleAgeSec: z.number().positive().optional(),
}).strict();

const capVaultAssetSchema = z.object({
  address: z.string(),
  name: z.string(),
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
}).strict();

const capVaultParamsSchema = z.object({
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  assets: z.array(capVaultAssetSchema).optional(),
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

const collateralPositionsRedemptionBridgeSchema = z.object({
  chain: z.string(),
  rpcMode: LiveReserveRpcModeSchema,
  holder: z.string(),
  tokenAddress: z.string(),
  tokenDecimals: z.number().int().nonnegative(),
  priceAddress: z.string().optional(),
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
}).strict();

const collateralPositionsParamsSchema = z.object({
  pricesUrl: z.string(),
  otherThresholdPct: z.number().positive().optional(),
  redemptionBridge: collateralPositionsRedemptionBridgeSchema.optional(),
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

const singleAssetProbeSchema = z.object({
  kind: z.literal("json-path"),
  path: z.array(z.string()).min(1),
  scale: z.number().positive().optional(),
}).strict();

const erc4626SingleAssetParamsSchema = z.object({
  slice: reserveSliceDescriptorSchema,
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
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

const liquityV1ParamsSchema = z.object({
  troveManagerAddress: z.string(),
  slice: reserveSliceDescriptorSchema,
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  redemptionRateProbe: redemptionRateProbeSchema.optional(),
}).strict();

const sgForgeCoinvertibleParamsSchema = z.object({
  coinType: z.enum(["eur", "usd"]).optional(),
}).strict();

const singleAssetParamsSchema = z.object({
  label: z.string(),
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  probe: singleAssetProbeSchema.optional(),
  reserveProbe: singleAssetProbeSchema.optional(),
  supplyProbe: singleAssetProbeSchema.optional(),
  timestampProbe: singleAssetProbeSchema.optional(),
  reserveSourceLabel: z.string().optional(),
  redemptionRateProbe: redemptionRateProbeSchema.optional(),
}).strict();

export const baseLiveReserveConfigSchema = z.object({
  version: z.number().int().positive(),
  semantics: LiveReserveSemanticsSchema,
  breakerScope: z.string().optional(),
  display: LiveReserveDisplaySchema.optional(),
  inputs: z.object({
    primary: LiveReserveInputSchema,
    fallbacks: z.array(LiveReserveInputSchema).optional(),
  }).strict(),
});

const abracadabraCauldronSchema = z.object({
  address: z.string(),
  collateralSymbol: z.string(),
  collateralAddress: z.string(),
  collateralDecimals: z.number().int().nonnegative(),
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
}).strict();

const abracadabraParamsSchema = z.object({
  rpcUrl: z.string().optional(),
  fallbackRpcUrl: z.string().optional(),
  cauldrons: z.array(abracadabraCauldronSchema).min(1),
}).strict();

export const adapterParamsSchemas = {
  abracadabra: abracadabraParamsSchema,
  accountable: accountableParamsSchema,
  "anzen-usdz": noParamsSchema,
  asymmetry: noParamsSchema,
  btcfi: btcfiParamsSchema,
  "cap-vault": capVaultParamsSchema,
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
  "frax-balance-sheet": noParamsSchema,
  fx: noParamsSchema,
  gho: ghoParamsSchema,
  infinifi: noParamsSchema,
  lista: evmBranchBalancesParamsSchema,
  "liquity-v1": liquityV1ParamsSchema,
  m0: noParamsSchema,
  mento: noParamsSchema,
  "openeden-usdo": noParamsSchema,
  "re-metrics": noParamsSchema,
  reservoir: noParamsSchema,
  "sgforge-coinvertible": sgForgeCoinvertibleParamsSchema,
  "single-asset": singleAssetParamsSchema,
  "sky-makercore": noParamsSchema,
  tether: noParamsSchema,
  "usdai-proof-of-reserves": noParamsSchema,
  "usd1-bundle-oracle": usd1BundleOracleParamsSchema,
  "usdd-data-platform": noParamsSchema,
} as const satisfies Record<LiveReserveAdapterKey, z.ZodTypeAny>;

export type LiveReserveAdapterParamsByKey = {
  [K in keyof typeof adapterParamsSchemas]: z.infer<(typeof adapterParamsSchemas)[K]>;
};

export type LiveReserveAdapterParams = LiveReserveAdapterParamsByKey[LiveReserveAdapterKey];

export type LiveReserveAdapterParamsSchemaMap = typeof adapterParamsSchemas;

export type LiveReserveAdapterParamsSchemaKey = keyof LiveReserveAdapterParamsSchemaMap;

export const VERIFIED_OR_UNVERIFIED_FRESHNESS = ["verified", "unverified"] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const VERIFIED_ONLY_FRESHNESS = ["verified"] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const UNVERIFIED_ONLY_FRESHNESS = ["unverified"] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const NOT_APPLICABLE_ONLY_FRESHNESS = ["not-applicable"] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];

export const MATERIAL_UNKNOWN_EXPOSURE_PCT = 5;
export const DASHBOARD_SOURCE_MAX_AGE_SEC = 3 * DAY_SECONDS;
export const DISCLOSURE_SOURCE_MAX_AGE_SEC = 7 * DAY_SECONDS;

export type LiveReserveSingleAssetProbe = z.infer<typeof singleAssetProbeSchema>;
export type LiveReserveRedemptionRateProbe = z.infer<typeof redemptionRateProbeSchema>;
