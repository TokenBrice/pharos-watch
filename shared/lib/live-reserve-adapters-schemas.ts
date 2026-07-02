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

type LiveReserveAdapterSchemaMetadata = {
  primaryInputKinds: readonly LiveReserveInputKind[];
  params: z.ZodTypeAny;
};

function defineLiveReserveAdapterSchemaMetadata<
  T extends Record<LiveReserveAdapterKey, LiveReserveAdapterSchemaMetadata>,
>(metadata: T): T {
  return metadata;
}

function createInputSchemaForKinds(kinds: readonly LiveReserveInputKind[]): z.ZodTypeAny {
  const schemas = kinds.map((kind) => LiveReserveInputSchemaByKind[kind]);
  if (schemas.length === 1) {
    return schemas[0];
  }
  // Cast: z.union requires a non-empty tuple type that TS cannot infer from .map(); length > 1 is guarded above
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
const depTypeRecordSchema = z.record(z.string(), LiveReserveDependencyTypeSchema);

const noParamsSchema = z.object({}).strict();

const liveReserveScoringPolicySchema = z
  .object({
    maxSourceAgeSec: z.number().positive().optional(),
    allowedDegradedWarningCodes: z.array(z.string().min(1)).optional(),
  })
  .strict();

const usd1BundleOracleParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const accountableParamsSchema = z
  .object({
    bucket: z
      .enum([
        "type",
        "reserves_split",
        "deployment",
        "type_split",
        "stablecoin_split",
        "exposure_split",
        "protocol_split",
      ])
      .optional(),
    riskMap: riskRecordSchema.optional(),
    renameMap: stringRecordSchema.optional(),
    coinIdMap: stringRecordSchema.optional(),
    depTypeMap: depTypeRecordSchema.optional(),
    totalReservesExcludeBuckets: z.array(z.string().min(1)).optional(),
    allowNegativeBuckets: z.array(z.string().min(1)).optional(),
    skipTotalReservesValidation: z.boolean().optional(),
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
    oracleMethod: z.enum(["latestRoundData", "getPrice", "getPriceData", "getAssetPrice"]).optional(),
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
    redemptionHandlerAddress: z.string().optional(),
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

const morphoVaultV1RedemptionLiquiditySchema = z
  .object({
    source: z.literal("morpho-vault-v1"),
    chainId: z.number().int().positive(),
    apiUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const morphoVaultV2RedemptionLiquiditySchema = z
  .object({
    source: z.literal("morpho-vault-v2"),
    chainId: z.number().int().positive(),
    apiUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

// Reviewer-asserted: the vault redeems atomically against its full ERC-4626
// backing because the underlying is released on demand from an external savings
// module (e.g. the Sky DSR pot) rather than held as an idle balance in the
// vault. Use only where the unconstrained-redemption property is verified, since
// the default idle-balance telemetry understates such vaults to ~0.
const atomicFullBackingRedemptionLiquiditySchema = z
  .object({
    source: z.literal("atomic-full-backing"),
  })
  .strict();

// Reviewer-asserted Yearn V3 multi-strategy vault path: the adapter measures
// same-run withdrawable capacity from totalIdle plus each funded strategy's
// maxRedeem(vault) value through the vault's default withdrawal queue. This is
// narrower than generic ERC-4626 NAV because strategy liquidity is re-probed on
// every reserve sync.
const yearnV3WithdrawableRedemptionLiquiditySchema = z
  .object({
    source: z.literal("yearn-v3-withdrawable"),
    settlementDelaySec: z.number().int().nonnegative().optional(),
  })
  .strict();

const erc4626SingleAssetParamsSchema = z
  .object({
    slice: reserveSliceDescriptorSchema,
    redemptionLiquidity: z
      .discriminatedUnion("source", [
        morphoVaultV1RedemptionLiquiditySchema,
        morphoVaultV2RedemptionLiquiditySchema,
        atomicFullBackingRedemptionLiquiditySchema,
        yearnV3WithdrawableRedemptionLiquiditySchema,
      ])
      .optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const evmSelectorSchema = z.string().regex(/^0x[0-9a-fA-F]{8}$/);

const m0WrapperUnderlyingParamsSchema = z
  .object({
    mode: z.enum(["wrapped-m-token", "m-extension"]),
    wrapperAddress: z.string().optional(),
    mTokenSelector: evmSelectorSchema.optional(),
    expectedMTokenAddress: z.string().optional(),
    swapFacilitySelector: evmSelectorSchema.optional(),
    expectedSwapFacilityAddress: z.string().optional(),
    swapperAddress: z.string().optional(),
    pausedSelector: evmSelectorSchema.optional(),
    canSwapViaPathSelector: evmSelectorSchema.optional(),
    slice: reserveSliceDescriptorSchema,
    sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const liquityNativeActivePoolParamsSchema = z
  .object({
    activePoolAddress: z.string(),
    collateralLabel: z.string(),
    collateralRisk: LiveReserveRiskSchema,
    collateralDecimals: z.number().int().nonnegative(),
    debtSelector: evmSelectorSchema,
    debtDecimals: z.number().int().nonnegative().optional(),
    collateralBalanceSelector: evmSelectorSchema,
    priceFeedAddress: z.string(),
    priceSelector: evmSelectorSchema,
    priceDecimals: z.number().int().nonnegative().optional(),
    troveManagerAddress: z.string(),
    tcrSelector: evmSelectorSchema,
    mcrSelector: evmSelectorSchema,
    borrowerOperationsAddress: z.string().optional(),
    redemptionRateSelector: evmSelectorSchema.optional(),
    redemptionRateDecimals: z.number().int().nonnegative().optional(),
    sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional(),
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
    priceToken: z
      .object({
        chain: z.string(),
        address: z.string(),
      })
      .strict()
      .optional(),
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
    sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional(),
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
    shutdownSelector: evmSelectorSchema.optional(),
  })
  .strict();

const ghoGsmModuleSchema = z
  .object({
    address: z.string(),
    label: z.string(),
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    risk: LiveReserveRiskSchema.optional(),
  })
  .strict();

const ghoParamsSchema = z
  .object({
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    gsmModules: z.array(ghoGsmModuleSchema).min(1),
    ghoTokenAddress: z.string().optional(),
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
    cdpStablecoin: z.enum(["GBPm", "JPYm", "CHFm", "XOFm"]).optional(),
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
  scoring: liveReserveScoringPolicySchema.optional(),
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

export const liveReserveAdapterSchemaMetadata = defineLiveReserveAdapterSchemaMetadata({
  abracadabra: { primaryInputKinds: ["onchain-evm"], params: abracadabraParamsSchema },
  accountable: { primaryInputKinds: ["http-json"], params: accountableParamsSchema },
  "anzen-usdz": { primaryInputKinds: ["onchain-evm"], params: noParamsSchema },
  asymmetry: { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "attestation-pdf-index": { primaryInputKinds: ["http-html"], params: attestationPdfIndexParamsSchema },
  "blast-usdb-yield-manager": { primaryInputKinds: ["onchain-evm"], params: blastUsdbYieldManagerParamsSchema },
  btcfi: { primaryInputKinds: ["http-json"], params: btcfiParamsSchema },
  "cap-vault": { primaryInputKinds: ["onchain-evm"], params: capVaultParamsSchema },
  "chainlink-nav": { primaryInputKinds: ["onchain-evm"], params: chainlinkNavParamsSchema },
  "chainlink-por": { primaryInputKinds: ["onchain-evm"], params: chainlinkPorParamsSchema },
  "circle-transparency": { primaryInputKinds: ["http-html"], params: circleTransparencyParamsSchema },
  "collateral-positions-api": { primaryInputKinds: ["http-json"], params: collateralPositionsParamsSchema },
  crvusd: { primaryInputKinds: ["http-json", "onchain-evm"], params: noParamsSchema },
  "curated-validated": { primaryInputKinds: ["onchain-evm", "onchain-solana"], params: curatedValidatedParamsSchema },
  "dola-inverse": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "erc4626-single-asset": { primaryInputKinds: ["onchain-evm"], params: erc4626SingleAssetParamsSchema },
  ethena: { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "evm-branch-balances": { primaryInputKinds: ["onchain-evm"], params: evmBranchBalancesParamsSchema },
  falcon: { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "fdusd-transparency": { primaryInputKinds: ["http-html"], params: noParamsSchema },
  "frax-balance-sheet": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "frax-fpi-collateral": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  fx: { primaryInputKinds: ["http-json", "onchain-evm"], params: fxParamsSchema },
  gho: { primaryInputKinds: ["onchain-evm"], params: ghoParamsSchema },
  infinifi: { primaryInputKinds: ["http-json"], params: noParamsSchema },
  jupusd: { primaryInputKinds: ["http-json"], params: jupusdParamsSchema },
  lista: { primaryInputKinds: ["onchain-evm"], params: evmBranchBalancesParamsSchema },
  "liquity-v1": { primaryInputKinds: ["onchain-evm"], params: liquityV1ParamsSchema },
  "liquity-native-active-pool": {
    primaryInputKinds: ["onchain-evm"],
    params: liquityNativeActivePoolParamsSchema,
  },
  "liquity-v2-branches": { primaryInputKinds: ["onchain-evm"], params: liquityV2BranchesParamsSchema },
  m0: { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "m0-wrapper-underlying": { primaryInputKinds: ["onchain-evm"], params: m0WrapperUnderlyingParamsSchema },
  mento: { primaryInputKinds: ["http-json"], params: mentoParamsSchema },
  "nest-vault-positions": { primaryInputKinds: ["http-json"], params: nestVaultPositionsParamsSchema },
  "openeden-usdo": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "origin-vault-balances": { primaryInputKinds: ["onchain-evm"], params: originVaultBalancesParamsSchema },
  "quantoz-transparency": { primaryInputKinds: ["http-html"], params: quantozTransparencyParamsSchema },
  "re-metrics": { primaryInputKinds: ["http-html"], params: noParamsSchema },
  "resupply-pairs": { primaryInputKinds: ["onchain-evm"], params: resupplyPairsParamsSchema },
  "reserve-protocol-dtf": { primaryInputKinds: ["http-json", "onchain-evm"], params: reserveProtocolDtfParamsSchema },
  reservoir: { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "ripple-transparency": { primaryInputKinds: ["http-html"], params: noParamsSchema },
  "sgforge-coinvertible": { primaryInputKinds: ["http-html"], params: sgForgeCoinvertibleParamsSchema },
  "sgho-wrapper": { primaryInputKinds: ["onchain-evm"], params: erc4626SingleAssetParamsSchema },
  "solstice-attestation": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "single-asset": { primaryInputKinds: ["http-json", "onchain-evm"], params: singleAssetParamsSchema },
  "sky-makercore": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "superstate-liquidity": { primaryInputKinds: ["onchain-evm"], params: superstateLiquidityParamsSchema },
  "river-protocol-info": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "usdgo-transparency": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "usdh-native-markets": { primaryInputKinds: ["http-html"], params: noParamsSchema },
  "usdai-proof-of-reserves": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  "usd1-bundle-oracle": { primaryInputKinds: ["onchain-evm"], params: usd1BundleOracleParamsSchema },
  "usdd-data-platform": { primaryInputKinds: ["http-json"], params: noParamsSchema },
  yamato: { primaryInputKinds: ["onchain-evm"], params: yamatoParamsSchema },
  "zephyr-scanner": { primaryInputKinds: ["http-json"], params: noParamsSchema },
});

type LiveReserveAdapterSchemaMetadataMap = typeof liveReserveAdapterSchemaMetadata;

export const LIVE_RESERVE_ADAPTER_PRIMARY_INPUT_KINDS = Object.fromEntries(
  Object.entries(liveReserveAdapterSchemaMetadata).map(([adapterKey, metadata]) => [
    adapterKey,
    metadata.primaryInputKinds,
  ]),
) as {
  [K in keyof LiveReserveAdapterSchemaMetadataMap]: LiveReserveAdapterSchemaMetadataMap[K]["primaryInputKinds"];
};

export const adapterParamsSchemas = Object.fromEntries(
  Object.entries(liveReserveAdapterSchemaMetadata).map(([adapterKey, metadata]) => [adapterKey, metadata.params]),
) as {
  [K in keyof LiveReserveAdapterSchemaMetadataMap]: LiveReserveAdapterSchemaMetadataMap[K]["params"];
};

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
export const NOT_APPLICABLE_ONLY_FRESHNESS = [
  "not-applicable",
] satisfies LiveReserveAdapterValidationPolicy["allowedFreshnessModes"];

export const MATERIAL_UNKNOWN_EXPOSURE_PCT = 5;
export const DASHBOARD_SOURCE_MAX_AGE_SEC = 3 * DAY_SECONDS;
export const DISCLOSURE_SOURCE_MAX_AGE_SEC = 7 * DAY_SECONDS;
// Some issuer attestations publish on a monthly cadence (e.g. Native Markets USDH);
// give those feeds a 33-day window (~month + 3d grace) before staleness degrades them.
export const MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 33 * DAY_SECONDS;
// Late monthly disclosure feeds get a wider reviewed window for issuers whose
// attestations routinely arrive after the next calendar month has started.
export const LATE_MONTHLY_DISCLOSURE_SOURCE_MAX_AGE_SEC = 4_000_000;

export type LiveReserveSingleAssetProbe = z.infer<typeof singleAssetProbeSchema>;
export type LiveReserveRedemptionRateProbe = z.infer<typeof redemptionRateProbeSchema>;
