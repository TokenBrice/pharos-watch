import { z } from "zod";
import { DAY_SECONDS } from "./time-constants";
import { DEPENDENCY_TYPE_VALUES } from "../types/dependency-types";
import { ReserveRiskSchema, ReserveSliceSchema } from "../types/reserves";
import {
  LIVE_RESERVE_RPC_MODE_VALUES,
  LIVE_RESERVE_SEMANTICS_VALUES,
  type LiveReserveAdapterKey,
  type LiveReserveAdapterValidationPolicy,
  type LiveReserveInput,
} from "../types/live-reserves";

const LiveReserveSemanticsSchema = z.enum(LIVE_RESERVE_SEMANTICS_VALUES);
const LiveReserveRpcModeSchema = z.enum(LIVE_RESERVE_RPC_MODE_VALUES);
const LiveReserveRiskSchema = ReserveRiskSchema;
const LiveReserveDependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);
type LiveReserveInputKind = LiveReserveInput["kind"];
const AbsoluteUrlSchema = z.string().url();

const LiveReserveInputSchemaByKind = {
  "http-json": z
    .object({
      kind: z.literal("http-json"),
      url: AbsoluteUrlSchema,
    })
    .strict(),
  "http-html": z
    .object({
      kind: z.literal("http-html"),
      url: AbsoluteUrlSchema,
    })
    .strict(),
  indexer: z
    .object({
      kind: z.literal("indexer"),
      url: AbsoluteUrlSchema,
    })
    .strict(),
  "onchain-solana": z
    .object({
      kind: z.literal("onchain-solana"),
    })
    .strict(),
  "onchain-evm": z
    .object({
      kind: z.literal("onchain-evm"),
      chain: z.string(),
      rpcMode: LiveReserveRpcModeSchema,
    })
    .strict(),
} as const satisfies Record<LiveReserveInputKind, z.ZodTypeAny>;

export const LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS = {
  abracadabra: ["onchain-evm"],
  accountable: ["http-json"],
  "anzen-usdz": ["onchain-evm"],
  asymmetry: ["http-json"],
  "attestation-pdf-index": ["http-html"],
  "blast-usdb-yield-manager": ["onchain-evm"],
  btcfi: ["http-json"],
  "buck-io-transparency": ["http-html"],
  "cap-vault": ["onchain-evm"],
  "centrifuge-vault": ["onchain-evm"],
  "chainlink-nav": ["onchain-evm"],
  "chainlink-por": ["onchain-evm"],
  "circle-transparency": ["http-html"],
  "collateral-positions-api": ["http-json"],
  crvusd: ["http-json", "onchain-evm"],
  "curated-validated": ["onchain-evm", "onchain-solana"],
  "dola-inverse": ["http-json"],
  "erc4626-single-asset": ["onchain-evm"],
  ethena: ["http-json"],
  "evm-branch-balances": ["onchain-evm"],
  falcon: ["http-json"],
  "fdusd-transparency": ["http-html"],
  "frax-balance-sheet": ["http-json"],
  "frax-fpi-collateral": ["http-json"],
  fx: ["http-json", "onchain-evm"],
  gho: ["onchain-evm"],
  infinifi: ["http-json"],
  jupusd: ["http-json"],
  lista: ["onchain-evm"],
  "liquity-v1": ["onchain-evm"],
  "liquity-v2-branches": ["onchain-evm"],
  m0: ["http-json"],
  mento: ["http-json"],
  "nest-vault-positions": ["http-json"],
  "openeden-usdo": ["http-json"],
  "origin-vault-balances": ["onchain-evm"],
  "quantoz-transparency": ["http-html"],
  "re-metrics": ["http-html"],
  "resupply-pairs": ["onchain-evm"],
  "reserve-protocol-dtf": ["http-json", "onchain-evm"],
  reservoir: ["http-json"],
  "ripple-transparency": ["http-html"],
  "sgforge-coinvertible": ["http-html"],
  "solstice-attestation": ["http-json"],
  "single-asset": ["http-json", "onchain-evm"],
  "sky-makercore": ["http-json"],
  "superstate-liquidity": ["onchain-evm"],
  tether: ["http-json"],
  "river-protocol-info": ["http-json"],
  "usdgo-transparency": ["http-json"],
  "usdh-native-markets": ["http-html"],
  "usdai-proof-of-reserves": ["http-json"],
  "usd1-bundle-oracle": ["onchain-evm"],
  "usdd-data-platform": ["http-json"],
  yamato: ["onchain-evm"],
  "zephyr-scanner": ["http-json"],
} as const satisfies Record<LiveReserveAdapterKey, readonly LiveReserveInputKind[]>;

function createInputSchemaForKinds(kinds: readonly LiveReserveInputKind[]): z.ZodTypeAny {
  const schemas = kinds.map((kind) => LiveReserveInputSchemaByKind[kind]);
  if (schemas.length === 1) {
    return schemas[0];
  }
  return z.union(schemas as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
}

export function createLiveReserveInputsSchema(adapterKey: LiveReserveAdapterKey): z.ZodTypeAny {
  const inputSchema = createInputSchemaForKinds(LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS[adapterKey]);
  return z
    .object({
      primary: inputSchema,
      fallbacks: z.array(inputSchema).optional(),
    })
    .strict();
}

const LiveReserveDisplaySchema = z
  .object({
    url: AbsoluteUrlSchema.optional(),
    label: z.string().optional(),
  })
  .strict();

const stringRecordSchema = z.record(z.string(), z.string());
const riskRecordSchema = z.record(z.string(), LiveReserveRiskSchema);

const noParamsSchema = z.object({}).strict();

const usd1BundleOracleParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const accountableParamsSchema = z
  .object({
    bucket: z
      .enum(["type", "reserves_split", "deployment", "type_split", "stablecoin_split", "exposure_split", "protocol_split"])
      .optional(),
    riskMap: riskRecordSchema.optional(),
    renameMap: stringRecordSchema.optional(),
  })
  .strict();

const attestationPdfIndexParamsSchema = z
  .object({
    slices: z.array(ReserveSliceSchema).min(1),
  })
  .strict();

const btcfiParamsSchema = z
  .object({
    handlersUrl: AbsoluteUrlSchema,
  })
  .strict();

const fxParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const blastUsdbYieldManagerParamsSchema = z
  .object({
    yieldManagerAddress: z.string(),
    supplyChain: z.string(),
    supplyTokenAddress: z.string(),
    supplyRpcUrl: AbsoluteUrlSchema,
    fallbackSupplyRpcUrl: AbsoluteUrlSchema.optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const chainlinkNavParamsSchema = z
  .object({
    oracleAddress: z.string(),
    tokenAddress: z.string(),
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    oracleMethod: z.enum(["latestRoundData", "getPrice", "getAssetPrice"]).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    maxOracleAgeSec: z.number().positive().optional(),
  })
  .strict();

const superstateLiquidityParamsSchema = chainlinkNavParamsSchema
  .extend({
    liquidityUrl: AbsoluteUrlSchema,
    ticker: z.enum(["USTB", "USCC"]),
  })
  .strict();

const capVaultAssetSchema = z
  .object({
    address: z.string(),
    name: z.string(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    priceUsd: z.number().positive().optional(),
  })
  .strict();

const capVaultParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    assets: z.array(capVaultAssetSchema).optional(),
  })
  .strict();

const chainlinkPorParamsSchema = z
  .object({
    porFeedAddress: z.string(),
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    reserveUnit: z.enum(["USD", "XAU", "XAG"]).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    maxOracleAgeSec: z.number().positive().optional(),
  })
  .strict();

const circleTransparencyParamsSchema = z
  .object({
    coinType: z.enum(["usdc", "eurc"]),
  })
  .strict();

const collateralPositionsRedemptionBridgeSchema = z
  .object({
    chain: z.string(),
    rpcMode: LiveReserveRpcModeSchema,
    holder: z.string(),
    tokenAddress: z.string(),
    tokenDecimals: z.number().int().nonnegative(),
    priceAddress: z.string().optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const collateralPositionsParamsSchema = z
  .object({
    pricesUrl: AbsoluteUrlSchema,
    otherThresholdPct: z.number().positive().optional(),
    redemptionBridge: collateralPositionsRedemptionBridgeSchema.optional(),
  })
  .strict();

const curatedValidatedParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const reserveProtocolDtfAssetSchema = z
  .object({
    address: z.string(),
    name: z.string(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    blacklistable: z.boolean().optional(),
  })
  .strict();

const reserveProtocolDtfParamsSchema = z
  .object({
    assets: z.array(reserveProtocolDtfAssetSchema).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const resupplyUnderlyingSchema = z
  .object({
    address: z.string(),
    name: z.string(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
  })
  .strict();

const resupplyPairSchema = z
  .object({
    key: z.string(),
    address: z.string(),
  })
  .strict();

const resupplyPairsParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    pairs: z.array(resupplyPairSchema).min(1),
    underlyings: z.array(resupplyUnderlyingSchema).min(1),
  })
  .strict();

const reserveSliceDescriptorSchema = z
  .object({
    name: z.string(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    expectedAssetAddress: z.string().optional(),
  })
  .strict();

const redemptionRateProbeSchema = z
  .object({
    contract: z.string(),
    selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
    decimals: z.number().int().positive().optional(),
  })
  .strict();

const singleAssetProbeSchema = z
  .object({
    kind: z.literal("json-path"),
    path: z.array(z.string()).min(1),
    scale: z.number().positive().optional(),
  })
  .strict();

const erc4626SingleAssetParamsSchema = z
  .object({
    slice: reserveSliceDescriptorSchema,
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const centrifugeVaultSliceSchema = z
  .object({
    name: z.string(),
    risk: LiveReserveRiskSchema,
  })
  .strict();

const centrifugeVaultParamsSchema = z
  .object({
    assetAddress: z.string(),
    slice: centrifugeVaultSliceSchema,
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const originVaultAssetSchema = z
  .object({
    address: z.string(),
    decimals: z.number().int().nonnegative(),
    name: z.string(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
  })
  .strict();

const originVaultBalancesParamsSchema = z
  .object({
    vaultAddress: z.string(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    assets: z.array(originVaultAssetSchema).min(1),
  })
  .strict();

const nestVaultPositionsParamsSchema = z
  .object({
    priceUrl: AbsoluteUrlSchema,
    lastPriceUpdateUrl: AbsoluteUrlSchema,
  })
  .strict();

const quantozTransparencyParamsSchema = z
  .object({
    token: z.enum(["EURQ", "USDQ"]),
  })
  .strict();

const evmBranchBalanceBranchSchema = z
  .object({
    name: z.string(),
    holder: z.string(),
    token: z
      .object({
        chain: z.string(),
        address: z.string(),
        decimals: z.number().int().nonnegative(),
      })
      .strict(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    priceUsd: z.number().positive().optional(),
  })
  .strict();

const evmBranchBalancesParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    branches: z.array(evmBranchBalanceBranchSchema).min(1),
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
    /**
     * When provided, the adapter calls `debtSelector` on `debtContract` (or the
     * first branch's holder if omitted) to fetch a system-wide debt/supply total
     * and emits `collateralizationRatio` in metadata.
     */
    debtSelector: z
      .string()
      .regex(/^0x[0-9a-fA-F]{8}$/)
      .optional(),
    debtContract: z.string().optional(),
    debtDecimals: z.number().int().nonnegative().optional(),
  })
  .strict();

const liquityV2BranchesParamsSchema = evmBranchBalancesParamsSchema
  .extend({
    shutdownSelector: z
      .string()
      .regex(/^0x[0-9a-fA-F]{8}$/)
      .optional(),
  })
  .strict();

const ghoGsmModuleSchema = z
  .object({
    address: z.string(),
    label: z.string(),
    coinId: z.string().optional(),
    risk: LiveReserveRiskSchema.optional(),
  })
  .strict();

const ghoParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    gsmModules: z.array(ghoGsmModuleSchema).min(1),
  })
  .strict();

const liquityV1ParamsSchema = z
  .object({
    troveManagerAddress: z.string(),
    slice: reserveSliceDescriptorSchema,
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
  })
  .strict();

const yamatoParamsSchema = z
  .object({
    yamatoAddress: z.string(),
    priceFeedAddress: z.string().optional(),
    slice: reserveSliceDescriptorSchema.optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const jupusdParamsSchema = z
  .object({
    snapshotsUrl: AbsoluteUrlSchema.optional(),
    oracleUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const mentoParamsSchema = z
  .object({
    cdpStablecoin: z.enum(["GBPm", "JPYm", "CHFm"]).optional(),
  })
  .strict();

const sgForgeCoinvertibleParamsSchema = z
  .object({
    coinType: z.enum(["eur", "usd"]).optional(),
  })
  .strict();

const singleAssetParamsSchema = z
  .object({
    label: z.string(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    probe: singleAssetProbeSchema.optional(),
    reserveProbe: singleAssetProbeSchema.optional(),
    supplyProbe: singleAssetProbeSchema.optional(),
    timestampProbe: singleAssetProbeSchema.optional(),
    reserveSourceLabel: z.string().optional(),
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
  })
  .strict();

export const baseLiveReserveConfigSchema = z.object({
  version: z.number().int().positive(),
  semantics: LiveReserveSemanticsSchema,
  breakerScope: z.string().min(1).optional(),
  display: LiveReserveDisplaySchema.optional(),
});

const abracadabraCauldronSchema = z
  .object({
    address: z.string(),
    collateralSymbol: z.string(),
    collateralAddress: z.string(),
    collateralDecimals: z.number().int().nonnegative(),
    risk: LiveReserveRiskSchema,
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    // Reserved for future V2/V3/V4 selector nuance; currently unused by the adapter.
    version: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })
  .strict();

const abracadabraParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    // BentoBox / DegenBox contract that backs the configured cauldrons. Used to
    // convert per-cauldron `totalCollateralShare` into underlying token amounts
    // via `toAmount(token, share, false)`.
    bentoBoxAddress: z.string(),
    cauldrons: z.array(abracadabraCauldronSchema).min(1),
  })
  .strict();

export const adapterParamsSchemas = {
  abracadabra: abracadabraParamsSchema,
  accountable: accountableParamsSchema,
  "anzen-usdz": noParamsSchema,
  asymmetry: noParamsSchema,
  "attestation-pdf-index": attestationPdfIndexParamsSchema,
  "blast-usdb-yield-manager": blastUsdbYieldManagerParamsSchema,
  btcfi: btcfiParamsSchema,
  "buck-io-transparency": noParamsSchema,
  "cap-vault": capVaultParamsSchema,
  "centrifuge-vault": centrifugeVaultParamsSchema,
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
  "frax-balance-sheet": noParamsSchema,
  "frax-fpi-collateral": noParamsSchema,
  fx: fxParamsSchema,
  gho: ghoParamsSchema,
  infinifi: noParamsSchema,
  jupusd: jupusdParamsSchema,
  lista: evmBranchBalancesParamsSchema,
  "liquity-v1": liquityV1ParamsSchema,
  "liquity-v2-branches": liquityV2BranchesParamsSchema,
  m0: noParamsSchema,
  mento: mentoParamsSchema,
  "nest-vault-positions": nestVaultPositionsParamsSchema,
  "openeden-usdo": noParamsSchema,
  "origin-vault-balances": originVaultBalancesParamsSchema,
  "quantoz-transparency": quantozTransparencyParamsSchema,
  "re-metrics": noParamsSchema,
  "resupply-pairs": resupplyPairsParamsSchema,
  "reserve-protocol-dtf": reserveProtocolDtfParamsSchema,
  reservoir: noParamsSchema,
  "ripple-transparency": noParamsSchema,
  "sgforge-coinvertible": sgForgeCoinvertibleParamsSchema,
  "solstice-attestation": noParamsSchema,
  "single-asset": singleAssetParamsSchema,
  "sky-makercore": noParamsSchema,
  "superstate-liquidity": superstateLiquidityParamsSchema,
  tether: noParamsSchema,
  "river-protocol-info": noParamsSchema,
  "usdgo-transparency": noParamsSchema,
  "usdh-native-markets": noParamsSchema,
  "usdai-proof-of-reserves": noParamsSchema,
  "usd1-bundle-oracle": usd1BundleOracleParamsSchema,
  "usdd-data-platform": noParamsSchema,
  yamato: yamatoParamsSchema,
  "zephyr-scanner": noParamsSchema,
} as const satisfies Record<LiveReserveAdapterKey, z.ZodTypeAny>;

export type LiveReserveAdapterParamsByKey = {
  [K in keyof typeof adapterParamsSchemas]: z.infer<(typeof adapterParamsSchemas)[K]>;
};

export type LiveReserveAdapterParams = LiveReserveAdapterParamsByKey[LiveReserveAdapterKey];

export type LiveReserveAdapterParamsSchemaMap = typeof adapterParamsSchemas;

export type LiveReserveAdapterParamsSchemaKey = keyof LiveReserveAdapterParamsSchemaMap;

export const VERIFIED_OR_UNVERIFIED_FRESHNESS = [
  "verified",
  "unverified",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const VERIFIED_ONLY_FRESHNESS = [
  "verified",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const UNVERIFIED_ONLY_FRESHNESS = [
  "unverified",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];
export const NOT_APPLICABLE_ONLY_FRESHNESS = [
  "not-applicable",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];

export const MATERIAL_UNKNOWN_EXPOSURE_PCT = 5;
export const DASHBOARD_SOURCE_MAX_AGE_SEC = 3 * DAY_SECONDS;
export const DISCLOSURE_SOURCE_MAX_AGE_SEC = 7 * DAY_SECONDS;
// Some issuer attestations publish on a monthly cadence (e.g. Native Markets USDH);
// give those feeds a 33-day window (~month + 3d grace) before staleness degrades them.
export const MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 33 * DAY_SECONDS;

export type LiveReserveSingleAssetProbe = z.infer<typeof singleAssetProbeSchema>;
export type LiveReserveRedemptionRateProbe = z.infer<typeof redemptionRateProbeSchema>;
