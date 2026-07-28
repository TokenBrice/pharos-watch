import { z } from "zod";
import { DEPENDENCY_TYPE_VALUES } from "../types/dependency-types";
import {
  LIVE_RESERVE_RPC_MODE_VALUES,
  LIVE_RESERVE_SEMANTICS_VALUES,
  type LiveReserveInput,
} from "../types/live-reserve-core";
import { ReserveRiskSchema, ReserveSliceSchema } from "../types/reserves";

const LiveReserveSemanticsSchema = z.enum(LIVE_RESERVE_SEMANTICS_VALUES);
const LiveReserveRpcModeSchema = z.enum(LIVE_RESERVE_RPC_MODE_VALUES);
const LiveReserveRiskSchema = ReserveRiskSchema;
const LiveReserveDependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);
export type LiveReserveInputKind = LiveReserveInput["kind"];
const AbsoluteUrlSchema = z.string().url();
const EvmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const EvmCodeHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

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

export function createLiveReserveInputSchemaForKinds(kinds: readonly LiveReserveInputKind[]): z.ZodTypeAny {
  const schemas = kinds.map((kind) => LiveReserveInputSchemaByKind[kind]);
  if (schemas.length === 1) {
    return schemas[0];
  }
  // Cast: z.union requires a non-empty tuple type that TS cannot infer from .map(); length > 1 is guarded above
  return z.union(schemas as unknown as [z.ZodTypeAny, ...z.ZodTypeAny[]]);
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

const fraxFpiCollateralParamsSchema = z
  .object({
    controllerAddress: EvmAddressSchema,
    fpiTokenAddress: EvmAddressSchema,
    fraxTokenAddress: EvmAddressSchema,
    expectedControllerCodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    expectedFraxPriceFeedAddress: EvmAddressSchema,
    expectedFraxPriceFeedCodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    expectedFraxPriceFeedDecimals: z.number().int().nonnegative().max(36),
    expectedFpiPriceFeedAddress: EvmAddressSchema,
    expectedFpiPriceFeedCodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    expectedFpiPriceFeedDecimals: z.number().int().nonnegative().max(36),
    expectedCpiTrackerAddress: EvmAddressSchema,
    expectedCpiTrackerCodeHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    maxPriceFeedAgeSec: z.number().int().positive(),
    fullConfidenceCpiTrackerAgeSec: z.number().int().positive(),
    maxCpiTrackerAgeSec: z.number().int().positive(),
    expectedRedeemFeeE6: z.number().int().nonnegative().max(1_000_000),
    outputTrackedAssetId: z.literal("frax-frax"),
    minOutputPriceUsd: z.number().finite().positive(),
    maxOutputPriceUsd: z.number().finite().positive(),
    sourceUrls: z.array(AbsoluteUrlSchema).min(1),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    if (params.minOutputPriceUsd > params.maxOutputPriceUsd) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["minOutputPriceUsd"],
        message: "minOutputPriceUsd must be less than or equal to maxOutputPriceUsd",
      });
    }
    if (params.fullConfidenceCpiTrackerAgeSec > params.maxCpiTrackerAgeSec) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fullConfidenceCpiTrackerAgeSec"],
        message: "fullConfidenceCpiTrackerAgeSec must be less than or equal to maxCpiTrackerAgeSec",
      });
    }
  });

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

// Reviewer-asserted K3 sBOLD path: the vault deploys its BOLD into Liquity V2
// Stability Pools (idle balance ~0), so the adapter measures same-run
// SP-withdrawable BOLD from the vault's own calcFragments() liquid-BOLD word —
// the value _maxWithdraw caps redemptions at — instead of the idle balance,
// which understates such vaults to ~0.
const sboldSpWithdrawableRedemptionLiquiditySchema = z
  .object({
    source: z.literal("sbold-sp-withdrawable"),
  })
  .strict();

// Reviewer-pinned sfrxUSD holder route. Ethereum sfrxUSD redemptions are
// disabled locally; the active path sends shares through Frax's Ethereum hop,
// redeems against the Fraxtal MintRedeemer inventory, then returns frxUSD.
// Every mutable identity and safety bound is explicit so the observer can fail
// closed on route drift rather than falling back to the local idle balance.
const fraxtalHopWithdrawableRedemptionLiquiditySchema = z
  .object({
    source: z.literal("fraxtal-hop-withdrawable"),
    fraxtalRpcUrl: AbsoluteUrlSchema,
    maxFinalizedBlockAgeSec: z.number().int().positive(),
    maxCrossChainBlockSkewSec: z.number().int().positive(),
    remoteHopAddress: EvmAddressSchema,
    expectedRemoteHopCodeHash: EvmCodeHashSchema,
    expectedEthereumSfrxUsdImplementationAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdProxyCodeHash: EvmCodeHashSchema,
    expectedEthereumSfrxUsdImplementationCodeHash: EvmCodeHashSchema,
    expectedEthereumEid: z.number().int().positive(),
    expectedFraxtalEid: z.number().int().positive(),
    expectedFraxtalHopAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftProxyCodeHash: EvmCodeHashSchema,
    expectedEthereumFrxUsdOftImplementationAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftImplementationCodeHash: EvmCodeHashSchema,
    expectedEthereumSfrxUsdOftAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdOftProxyCodeHash: EvmCodeHashSchema,
    expectedEthereumSfrxUsdOftImplementationAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdOftImplementationCodeHash: EvmCodeHashSchema,
    expectedEthereumFrxUsdAddress: EvmAddressSchema,
    expectedEthUsdFeedAddress: EvmAddressSchema,
    expectedEthUsdFeedCodeHash: EvmCodeHashSchema,
    expectedEthUsdAggregatorAddress: EvmAddressSchema,
    expectedEthUsdAggregatorCodeHash: EvmCodeHashSchema,
    maxEthUsdOracleAgeSec: z.number().int().positive(),
    expectedFraxtalHopCodeHash: EvmCodeHashSchema,
    mintRedeemerProxyAddress: EvmAddressSchema,
    expectedMintRedeemerProxyCodeHash: EvmCodeHashSchema,
    expectedMintRedeemerImplementationAddress: EvmAddressSchema,
    expectedMintRedeemerImplementationCodeHash: EvmCodeHashSchema,
    expectedFrxUsdLockboxAddress: EvmAddressSchema,
    expectedFrxUsdLockboxProxyCodeHash: EvmCodeHashSchema,
    expectedFrxUsdLockboxImplementationAddress: EvmAddressSchema,
    expectedFrxUsdLockboxImplementationCodeHash: EvmCodeHashSchema,
    expectedSfrxUsdLockboxAddress: EvmAddressSchema,
    expectedSfrxUsdLockboxProxyCodeHash: EvmCodeHashSchema,
    expectedSfrxUsdLockboxImplementationAddress: EvmAddressSchema,
    expectedSfrxUsdLockboxImplementationCodeHash: EvmCodeHashSchema,
    expectedFraxtalFrxUsdAddress: EvmAddressSchema,
    expectedFraxtalSfrxUsdAddress: EvmAddressSchema,
    expectedVaultOracleAddress: EvmAddressSchema,
    expectedVaultOracleCodeHash: EvmCodeHashSchema,
    maxOracleToleranceSec: z.number().int().positive(),
    maxOraclePriceDeviationBps: z.number().finite().nonnegative(),
    maxRedemptionFeeBps: z.number().finite().nonnegative(),
    sourceUrls: z.array(AbsoluteUrlSchema).min(1),
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
        sboldSpWithdrawableRedemptionLiquiditySchema,
        fraxtalHopWithdrawableRedemptionLiquiditySchema,
      ])
      .optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const evmSelectorSchema = z.string().regex(/^0x[0-9a-fA-F]{8}$/);

// Same wrapper + M token contract addresses as the primary chain, deployed on
// another EVM network (M0's native-multichain model reuses addresses across
// chains). Used to aggregate total supply / underlying M balance across all
// deployments instead of reading only the primary chain.
const m0WrapperAdditionalDeploymentSchema = z
  .object({
    chain: z.string(),
    rpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

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
    additionalDeployments: z.array(m0WrapperAdditionalDeploymentSchema).min(1).optional(),
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

const pusdVaultAssetSchema = z
  .object({
    address: z.string(),
    decimals: z.number().int().nonnegative(),
  })
  .strict();

const pusdVaultParamsSchema = z
  .object({
    vaultAddress: z.string(),
    assets: z.array(pusdVaultAssetSchema).min(1),
    slice: reserveSliceDescriptorSchema,
    sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
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

const liquityV2MechanismMetricsBranchSchema = z
  .object({
    name: z.string().min(1),
    troveManagerAddress: EvmAddressSchema,
    stabilityPoolAddress: EvmAddressSchema,
  })
  .strict();

const liquityV2MechanismMetricsSchema = z
  .object({
    supplyTokenAddress: EvmAddressSchema,
    branchPriceSelector: evmSelectorSchema.optional(),
    stabilityPoolDepositsSelector: evmSelectorSchema,
    maxSupplyDebtDivergencePct: z.number().finite().nonnegative().optional(),
    branches: z.array(liquityV2MechanismMetricsBranchSchema).min(1),
  })
  .strict();

const liquityV2BranchesParamsSchema = evmBranchBalancesParamsSchema
  .extend({
    shutdownSelector: evmSelectorSchema.optional(),
    mechanismMetrics: liquityV2MechanismMetricsSchema.optional(),
  })
  .strict()
  .superRefine((params, ctx) => {
    if (!params.mechanismMetrics) return;

    const reserveNames = new Set(params.branches.map((branch) => branch.name));
    const metricNames = new Set<string>();
    for (const [index, branch] of params.mechanismMetrics.branches.entries()) {
      if (metricNames.has(branch.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["mechanismMetrics", "branches", index, "name"],
          message: `Duplicate mechanism-metrics branch: ${branch.name}`,
        });
      }
      metricNames.add(branch.name);
      if (!reserveNames.has(branch.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["mechanismMetrics", "branches", index, "name"],
          message: `Unknown reserve branch: ${branch.name}`,
        });
      }
    }

    for (const [index, branch] of params.branches.entries()) {
      if (!metricNames.has(branch.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["branches", index, "name"],
          message: `Missing mechanism-metrics binding for reserve branch: ${branch.name}`,
        });
      }
    }
  });

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

// Broker-pool redemption: the coin's own token trades against a stable/USDm
// counter asset in a Mento V2 BiPoolManager pool. `pools` names the token pair;
// the adapter enumerates BiPoolManager.getExchangeIds()/getPoolExchange() at
// runtime and matches by these addresses rather than hardcoding exchangeIds.
const mentoBrokerPoolCounterAssetSchema = z
  .object({
    address: z.string(),
    label: z.string().optional(),
  })
  .strict();

const mentoBrokerPoolEntrySchema = z
  .object({
    selfTokenAddress: z.string(),
    counterAsset: mentoBrokerPoolCounterAssetSchema,
  })
  .strict();

const mentoBrokerPoolRedemptionParamsSchema = z
  .object({
    kind: z.literal("broker-pool"),
    pools: z.array(mentoBrokerPoolEntrySchema).min(1),
    sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

// Liquity-v2-fork CDP redemption (GBPm/mento-protocol/bold): capacity reads
// ActivePool debt against the CDP's own token total supply.
const mentoLiquityV2CrRedemptionParamsSchema = z
  .object({
    kind: z.literal("liquity-v2-cr"),
    collateralRegistryAddress: z.string(),
    troveManagerAddress: z.string(),
    activePoolAddress: z.string(),
    tokenAddress: z.string(),
    sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

// Mento V3 FPMM pool (JPYm/CHFm): capacity reads the USDm balance held by the
// pool; no fee telemetry (FPMM fee getter is not verified).
const mentoFpmmPoolRedemptionParamsSchema = z
  .object({
    kind: z.literal("fpmm-pool"),
    poolAddress: z.string(),
    usdmTokenAddress: z.string(),
    sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional(),
    rpcUrl: AbsoluteUrlSchema.optional(),
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
  })
  .strict();

const mentoRedemptionParamsSchema = z.discriminatedUnion("kind", [
  mentoBrokerPoolRedemptionParamsSchema,
  mentoLiquityV2CrRedemptionParamsSchema,
  mentoFpmmPoolRedemptionParamsSchema,
]);

const mentoParamsSchema = z
  .object({
    cdpStablecoin: z.enum(["GBPm", "JPYm", "CHFm", "XOFm"]).optional(),
    redemption: mentoRedemptionParamsSchema.optional(),
  })
  .strict();

const sgForgeCoinvertibleParamsSchema = z
  .object({
    coinType: z.enum(["eur", "usd"]).optional(),
  })
  .strict();

const spikoApiParamsSchema = z
  .object({
    shareClassSymbol: z.string(),
    slice: reserveSliceDescriptorSchema,
  })
  .strict();

const unitedPorParamsSchema = z
  .object({
    slice: reserveSliceDescriptorSchema,
  })
  .strict();

const tetherTransparencyParamsSchema = z
  .object({
    currencyIso: z.enum(["usdt", "xaut"]),
    slices: z.array(ReserveSliceSchema).min(1),
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

export const LIVE_RESERVE_PARAM_SCHEMAS = {
  none: noParamsSchema,
  abracadabra: abracadabraParamsSchema,
  accountable: accountableParamsSchema,
  attestationPdfIndex: attestationPdfIndexParamsSchema,
  blastUsdbYieldManager: blastUsdbYieldManagerParamsSchema,
  btcfi: btcfiParamsSchema,
  capVault: capVaultParamsSchema,
  chainlinkNav: chainlinkNavParamsSchema,
  chainlinkPor: chainlinkPorParamsSchema,
  circleTransparency: circleTransparencyParamsSchema,
  collateralPositions: collateralPositionsParamsSchema,
  curatedValidated: curatedValidatedParamsSchema,
  erc4626SingleAsset: erc4626SingleAssetParamsSchema,
  evmBranchBalances: evmBranchBalancesParamsSchema,
  fraxFpiCollateral: fraxFpiCollateralParamsSchema,
  fx: fxParamsSchema,
  gho: ghoParamsSchema,
  jupusd: jupusdParamsSchema,
  liquityNativeActivePool: liquityNativeActivePoolParamsSchema,
  liquityV1: liquityV1ParamsSchema,
  liquityV2Branches: liquityV2BranchesParamsSchema,
  m0WrapperUnderlying: m0WrapperUnderlyingParamsSchema,
  mento: mentoParamsSchema,
  nestVaultPositions: nestVaultPositionsParamsSchema,
  originVaultBalances: originVaultBalancesParamsSchema,
  pusdVault: pusdVaultParamsSchema,
  quantozTransparency: quantozTransparencyParamsSchema,
  reserveProtocolDtf: reserveProtocolDtfParamsSchema,
  resupplyPairs: resupplyPairsParamsSchema,
  sgForgeCoinvertible: sgForgeCoinvertibleParamsSchema,
  singleAsset: singleAssetParamsSchema,
  spikoApi: spikoApiParamsSchema,
  superstateLiquidity: superstateLiquidityParamsSchema,
  tetherTransparency: tetherTransparencyParamsSchema,
  unitedPor: unitedPorParamsSchema,
  usd1BundleOracle: usd1BundleOracleParamsSchema,
  yamato: yamatoParamsSchema,
} as const;

export type LiveReserveParamSchemaKey = keyof typeof LIVE_RESERVE_PARAM_SCHEMAS;

export * from "./live-reserve-adapter-policy";

export type LiveReserveSingleAssetProbe = z.infer<typeof singleAssetProbeSchema>;
export type LiveReserveRedemptionRateProbe = z.infer<typeof redemptionRateProbeSchema>;
