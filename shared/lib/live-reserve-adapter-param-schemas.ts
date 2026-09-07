import { z } from "zod";
import { DEPENDENCY_TYPE_VALUES } from "../types/dependency-types";
import {
  LIVE_RESERVE_RPC_MODE_VALUES,
} from "../types/live-reserve-core";
import { RedemptionHolderEligibilitySchema } from "../types/redemption";
import {
  ReserveAssetClassSchema,
  ReserveRiskFactorSchema,
  ReserveRiskSchema,
  ReserveSliceSchema,
} from "../types/reserves";

const LiveReserveRpcModeSchema = z.enum(LIVE_RESERVE_RPC_MODE_VALUES);
const LiveReserveRiskSchema = ReserveRiskSchema;
const LiveReserveDependencyTypeSchema = z.enum(DEPENDENCY_TYPE_VALUES);
const AbsoluteUrlSchema = z.string().url();
const EvmAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const EvmWordSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const EvmSelectorSchema = z.string().regex(/^0x[0-9a-fA-F]{8}$/);

const OptionalEvmRpcFields = {
  rpcUrl: AbsoluteUrlSchema.optional(),
  fallbackRpcUrl: AbsoluteUrlSchema.optional(),
} as const;
const RequiredSourceUrlsFields = { sourceUrls: z.array(AbsoluteUrlSchema).min(1) } as const;
const OptionalSourceUrlsFields = { sourceUrls: z.array(AbsoluteUrlSchema).min(1).optional() } as const;
const NonemptySourceUrlsFields = { sourceUrls: z.array(AbsoluteUrlSchema).nonempty() } as const;
const TrackedExposureFields = {
  risk: LiveReserveRiskSchema,
  coinId: z.string().optional(),
  depType: LiveReserveDependencyTypeSchema.optional(),
} as const;
const StringAddressFields = { address: z.string() } as const;
const EvmAddressFields = { address: EvmAddressSchema } as const;
const OptionalOracleFreshnessFields = { maxOracleAgeSec: z.number().positive().optional() } as const;

const stringRecordSchema = z.record(z.string(), z.string());
const riskRecordSchema = z.record(z.string(), LiveReserveRiskSchema);
const depTypeRecordSchema = z.record(z.string(), LiveReserveDependencyTypeSchema);

const noParamsSchema = z.object({}).strict();

const usd1BundleOracleParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
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
    sourceKeyMap: stringRecordSchema.optional(),
    coinIdMap: stringRecordSchema.optional(),
    depTypeMap: depTypeRecordSchema.optional(),
    totalReservesExcludeBuckets: z.array(z.string().min(1)).optional(),
    allowNegativeBuckets: z.array(z.string().min(1)).optional(),
  })
  .strict();

const attestationPdfIndexParamsSchema = z
  .object({
    slices: z.array(ReserveSliceSchema).min(1),
  })
  .strict();

const assuranceHostSchema = z.string().regex(/^[A-Za-z0-9.-]+$/);
const assuranceParamsShape = {
  indexHost: assuranceHostSchema,
  reportHosts: z.array(assuranceHostSchema).min(1),
};

const audxAssuranceParamsSchema = z
  .object({
    product: z.literal("AUDX"),
    profile: z.literal("audx-v1"),
    ...assuranceParamsShape,
  })
  .strict();

const europAssuranceParamsSchema = z
  .object({
    product: z.literal("EUROP"),
    profile: z.literal("europ-v1"),
    ...assuranceParamsShape,
  })
  .strict();

const straitsxAssuranceParamsSchema = z
  .object({
    product: z.enum(["XSGD", "XUSD"]),
    profile: z.literal("straitsx-v1"),
    ...assuranceParamsShape,
  })
  .strict();

const usdgoAssuranceParamsSchema = z
  .object({
    product: z.literal("USDGO"),
    profile: z.literal("usdgo-v1"),
    ...assuranceParamsShape,
    issuerCrossCheckUrl: z.literal("https://www.usdgo.com/api/lark-bitable"),
  })
  .strict();

const mocV3BucketSchema = z
  .object({
    ...EvmAddressFields,
    expectedProxyCodeHash: EvmWordSchema,
    expectedImplementationAddress: EvmAddressSchema,
    expectedImplementationCodeHash: EvmWordSchema,
    collateralToken: EvmAddressSchema,
    collateralDecimals: z.number().int().nonnegative().max(36),
    expectedPegContainerProvider: EvmAddressSchema,
    expectedPriceProvider: EvmAddressSchema,
  })
  .strict();

const mocV3BucketsParamsSchema = z
  .object({
    rpcUrl: z.literal("https://public-node.rsk.co"),
    fallbackRpcUrl: z.literal("https://mycrypto.rsk.co"),
    confirmationDepth: z.number().int().positive().max(256),
    maxBlockAgeSec: z.number().int().positive(),
    maxFutureSkewSec: z.number().int().nonnegative(),
    maxMarketProtocolDivergencePct: z.number().positive().max(100),
    walletExcessInfoPct: z.number().nonnegative().max(100),
    walletExcessDegradedPct: z.number().positive().max(100),
    branchMaterialityPct: z.number().positive().max(100),
    canonicalUsdrif: z
      .object({
        ...EvmAddressFields,
        expectedProxyCodeHash: EvmWordSchema,
        decimals: z.number().int().nonnegative().max(36),
      })
      .strict(),
    rifToken: z
      .object({
        ...EvmAddressFields,
        expectedCodeHash: EvmWordSchema,
        decimals: z.number().int().nonnegative().max(36),
      })
      .strict(),
    docToken: z
      .object({
        ...EvmAddressFields,
        expectedCodeHash: EvmWordSchema,
        decimals: z.number().int().nonnegative().max(36),
      })
      .strict(),
    rifBucket: mocV3BucketSchema,
    docBucket: mocV3BucketSchema,
    ...RequiredSourceUrlsFields,
  })
  .strict()
  .superRefine((params, ctx) => {
    if (params.walletExcessInfoPct >= params.walletExcessDegradedPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["walletExcessInfoPct"],
        message: "walletExcessInfoPct must be less than walletExcessDegradedPct",
      });
    }
    if (params.rifBucket.collateralToken.toLowerCase() !== params.rifToken.address.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rifBucket", "collateralToken"],
        message: "RIF bucket collateral token must match rifToken.address",
      });
    }
    if (params.docBucket.collateralToken.toLowerCase() !== params.docToken.address.toLowerCase()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["docBucket", "collateralToken"],
        message: "DOC bucket collateral token must match docToken.address",
      });
    }
  });

const btcfiParamsSchema = z
  .object({
    handlersUrl: AbsoluteUrlSchema,
  })
  .strict();

const fxParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
  })
  .strict();

const fraxFpiCollateralParamsSchema = z
  .object({
    controllerAddress: EvmAddressSchema,
    fpiTokenAddress: EvmAddressSchema,
    fraxTokenAddress: EvmAddressSchema,
    expectedControllerCodeHash: EvmWordSchema,
    expectedFraxPriceFeedAddress: EvmAddressSchema,
    expectedFraxPriceFeedCodeHash: EvmWordSchema,
    expectedFraxPriceFeedDecimals: z.number().int().nonnegative().max(36),
    expectedFpiPriceFeedAddress: EvmAddressSchema,
    expectedFpiPriceFeedCodeHash: EvmWordSchema,
    expectedFpiPriceFeedDecimals: z.number().int().nonnegative().max(36),
    expectedCpiTrackerAddress: EvmAddressSchema,
    expectedCpiTrackerCodeHash: EvmWordSchema,
    maxPriceFeedAgeSec: z.number().int().positive(),
    fullConfidenceCpiTrackerAgeSec: z.number().int().positive(),
    maxCpiTrackerAgeSec: z.number().int().positive(),
    expectedRedeemFeeE6: z.number().int().nonnegative().max(1_000_000),
    outputTrackedAssetId: z.literal("frax-frax"),
    minOutputPriceUsd: z.number().finite().positive(),
    maxOutputPriceUsd: z.number().finite().positive(),
    ...RequiredSourceUrlsFields,
    ...OptionalEvmRpcFields,
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
    ...OptionalEvmRpcFields,
  })
  .strict();

const chainlinkNavParamsSchema = z
  .object({
    oracleAddress: z.string(),
    tokenAddress: z.string(),
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    sourceKey: z.string()
      .trim()
      .min(3)
      .max(160)
      .regex(/^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._:/-]*$/)
      .optional(),
    oracleMethod: z.enum(["latestRoundData", "getPrice", "getPriceData", "getAssetPrice"]).optional(),
    ...OptionalEvmRpcFields,
    ...OptionalOracleFreshnessFields,
    redemptionCapacity: z
      .object({
        managerAddress: EvmAddressSchema,
        usdcAddress: EvmAddressSchema,
        routerAddress: EvmAddressSchema,
        sourceAddress: EvmAddressSchema,
        pauseSelector: EvmSelectorSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const chronicleNavParamsSchema = z
  .object({
    consumerAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    ...OptionalEvmRpcFields,
    ...OptionalOracleFreshnessFields,
  })
  .strict();

const usdaiHubParamsSchema = z
  .object({
    hubAddress: EvmAddressSchema,
    baseTokenAddress: EvmAddressSchema,
    implementationAddress: EvmAddressSchema,
    redemptionCapacity: z
      .object({
        holderEligibility: RedemptionHolderEligibilitySchema,
        ...NonemptySourceUrlsFields,
      })
      .strict(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const xdaiBridgeParamsSchema = z
  .object({
    foreignBridgeAddress: EvmAddressSchema,
    homeBridgeAddress: EvmAddressSchema,
    blockRewardAddress: EvmAddressSchema,
    usdsDepositContractAddress: EvmAddressSchema,
    usdsAddress: EvmAddressSchema,
    susdsAddress: EvmAddressSchema,
    daiAddress: EvmAddressSchema,
    sdaiAddress: EvmAddressSchema,
    ethereumRpcUrl: AbsoluteUrlSchema.optional(),
    ethereumFallbackRpcUrl: AbsoluteUrlSchema.optional(),
    gnosisRpcUrl: AbsoluteUrlSchema.optional(),
    gnosisFallbackRpcUrl: AbsoluteUrlSchema.optional(),
    finalityTag: z.enum(["safe", "finalized"]).optional(),
    maxBlockAgeSec: z.number().int().positive().optional(),
    maxFutureBlockSkewSec: z.number().int().nonnegative().optional(),
    crossChainSkewWarningSec: z.number().int().nonnegative().optional(),
    maxCrossChainSkewSec: z.number().int().positive().optional(),
    coverageShortfallWarningRatio: z.number().finite().positive().max(1).optional(),
    surplusWarningRatio: z.number().finite().gt(1).optional(),
    maxSurplusRatio: z.number().finite().gt(1).optional(),
    legacyWarningPct: z.number().finite().nonnegative().optional(),
    legacyMaterialityPct: z.number().finite().positive().max(100).optional(),
    maxWithdrawDivergencePct: z.number().finite().nonnegative().max(100).optional(),
    ...OptionalSourceUrlsFields,
  })
  .strict()
  .superRefine((params, ctx) => {
    if (
      params.crossChainSkewWarningSec != null &&
      params.maxCrossChainSkewSec != null &&
      params.crossChainSkewWarningSec > params.maxCrossChainSkewSec
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["crossChainSkewWarningSec"],
        message: "crossChainSkewWarningSec must be less than or equal to maxCrossChainSkewSec",
      });
    }
    if (
      params.surplusWarningRatio != null &&
      params.maxSurplusRatio != null &&
      params.surplusWarningRatio > params.maxSurplusRatio
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["surplusWarningRatio"],
        message: "surplusWarningRatio must be less than or equal to maxSurplusRatio",
      });
    }
    if (
      params.legacyWarningPct != null &&
      params.legacyMaterialityPct != null &&
      params.legacyWarningPct > params.legacyMaterialityPct
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["legacyWarningPct"],
        message: "legacyWarningPct must be less than or equal to legacyMaterialityPct",
      });
    }
  });

const hiveHbdProtocolParamsSchema = z
  .object({
    chain: z.literal("hive-mainnet"),
    hardfork: z.literal("hf26-plus"),
    treasuryAccount: z.literal("hive.fund"),
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
    ...StringAddressFields,
    name: z.string(),
    ...TrackedExposureFields,
    priceUsd: z.number().positive().optional(),
  })
  .strict();

const capVaultParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    assets: z.array(capVaultAssetSchema).optional(),
  })
  .strict();

const chainlinkPorIssuerCirculationProbeSchema = z
  .object({
    kind: z.literal("backed-graphql"),
    url: AbsoluteUrlSchema,
    reserveSymbol: z.string().trim().min(1),
  })
  .strict();

const chainlinkPorParamsSchema = z
  .object({
    porFeedAddress: z.string(),
    assetLabel: z.string(),
    assetRisk: LiveReserveRiskSchema,
    reserveUnit: z.enum(["USD", "XAU", "XAG", "SHARES"]).optional(),
    ...OptionalEvmRpcFields,
    ...OptionalOracleFreshnessFields,
    issuerCirculationProbe: chainlinkPorIssuerCirculationProbeSchema.optional(),
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
    ...OptionalEvmRpcFields,
  })
  .strict();

const collateralPositionsRedemptionBasketBridgeSchema = z
  .object({
    label: z.string().trim().min(1),
    bridgeAddress: EvmAddressSchema,
    tokenAddress: EvmAddressSchema,
    tokenDecimals: z.number().int().nonnegative(),
  })
  .strict();

const collateralPositionsRedemptionBridgeBasketSchema = z
  .object({
    chain: z.string().min(1),
    rpcMode: LiveReserveRpcModeSchema,
    dEuroAddress: EvmAddressSchema,
    eurUsdPriceAddress: EvmAddressSchema,
    bridges: z.array(collateralPositionsRedemptionBasketBridgeSchema).nonempty().max(16),
    ...OptionalEvmRpcFields,
    ...NonemptySourceUrlsFields,
  })
  .strict();

const collateralPositionsParamsSchema = z
  .object({
    pricesUrl: AbsoluteUrlSchema,
    otherThresholdPct: z.number().positive().optional(),
    redemptionBridge: collateralPositionsRedemptionBridgeSchema.optional(),
    redemptionBridgeBasket: collateralPositionsRedemptionBridgeBasketSchema.optional(),
  })
  .strict()
  .refine((params) => !(params.redemptionBridge && params.redemptionBridgeBasket), {
    message: "redemptionBridge and redemptionBridgeBasket are mutually exclusive",
  });

/** Opt-in live redemption probe for curated coins. The shape only describes
 *  atomic, same-block routes: a single uint256 read of what the route can pay
 *  out right now, valued 1:1 in USD. */
const curatedValidatedRedemptionCapacitySchema = z
  .object({
    chain: z.string().min(1),
    capacityRead: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("selector"),
          contract: EvmAddressSchema,
          selector: EvmSelectorSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("erc20-balance-of"),
          contract: EvmAddressSchema,
          holder: EvmAddressSchema,
        })
        .strict(),
    ]),
    /** Address getters the route must still resolve to. Any mismatch means the
     *  pinned contracts no longer describe this route, so nothing is emitted. */
    identityChecks: z
      .array(
        z
          .object({
            contract: EvmAddressSchema,
            selector: EvmSelectorSchema,
            expectedAddress: EvmAddressSchema,
          })
          .strict(),
      )
      .nonempty()
      .optional(),
    pauseCheck: z
      .object({ contract: EvmAddressSchema, selector: EvmSelectorSchema })
      .strict()
      .optional(),
    decimals: z.number().int().min(0).max(36),
    holderEligibility: RedemptionHolderEligibilitySchema,
    ...NonemptySourceUrlsFields,
  })
  .strict();

const curatedValidatedParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    redemptionCapacity: curatedValidatedRedemptionCapacitySchema.optional(),
  })
  .strict();

const reserveProtocolDtfAssetSchema = z
  .object({
    ...StringAddressFields,
    name: z.string(),
    ...TrackedExposureFields,
    blacklistable: z.boolean().optional(),
  })
  .strict();

const reserveProtocolDtfParamsSchema = z
  .object({
    assets: z.array(reserveProtocolDtfAssetSchema).optional(),
    ...OptionalEvmRpcFields,
  })
  .strict();

const resupplyUnderlyingSchema = z
  .object({
    ...StringAddressFields,
    name: z.string(),
    ...TrackedExposureFields,
  })
  .strict();

const resupplyPairSchema = z
  .object({
    key: z.string(),
    ...StringAddressFields,
  })
  .strict();

const resupplyPairsParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    redemptionHandlerAddress: z.string().optional(),
    pairs: z.array(resupplyPairSchema).min(1),
    underlyings: z.array(resupplyUnderlyingSchema).min(1),
  })
  .strict();

const reserveSliceDescriptorSchema = z
  .object({
    name: z.string(),
    ...TrackedExposureFields,
    expectedAssetAddress: z.string().optional(),
  })
  .strict();

const redemptionRateProbeSchema = z
  .object({
    contract: z.string(),
    selector: EvmSelectorSchema,
    decimals: z.number().int().positive(),
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
    expectedRemoteHopCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdImplementationAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdProxyCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdImplementationCodeHash: EvmWordSchema,
    expectedEthereumEid: z.number().int().positive(),
    expectedFraxtalEid: z.number().int().positive(),
    expectedFraxtalHopAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftProxyCodeHash: EvmWordSchema,
    expectedEthereumFrxUsdOftImplementationAddress: EvmAddressSchema,
    expectedEthereumFrxUsdOftImplementationCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdOftAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdOftProxyCodeHash: EvmWordSchema,
    expectedEthereumSfrxUsdOftImplementationAddress: EvmAddressSchema,
    expectedEthereumSfrxUsdOftImplementationCodeHash: EvmWordSchema,
    expectedEthereumFrxUsdAddress: EvmAddressSchema,
    expectedEthUsdFeedAddress: EvmAddressSchema,
    expectedEthUsdFeedCodeHash: EvmWordSchema,
    expectedEthUsdAggregatorAddress: EvmAddressSchema,
    expectedEthUsdAggregatorCodeHash: EvmWordSchema,
    maxEthUsdOracleAgeSec: z.number().int().positive(),
    expectedFraxtalHopCodeHash: EvmWordSchema,
    mintRedeemerProxyAddress: EvmAddressSchema,
    expectedMintRedeemerProxyCodeHash: EvmWordSchema,
    expectedMintRedeemerImplementationAddress: EvmAddressSchema,
    expectedMintRedeemerImplementationCodeHash: EvmWordSchema,
    expectedFrxUsdLockboxAddress: EvmAddressSchema,
    expectedFrxUsdLockboxProxyCodeHash: EvmWordSchema,
    expectedFrxUsdLockboxImplementationAddress: EvmAddressSchema,
    expectedFrxUsdLockboxImplementationCodeHash: EvmWordSchema,
    expectedSfrxUsdLockboxAddress: EvmAddressSchema,
    expectedSfrxUsdLockboxProxyCodeHash: EvmWordSchema,
    expectedSfrxUsdLockboxImplementationAddress: EvmAddressSchema,
    expectedSfrxUsdLockboxImplementationCodeHash: EvmWordSchema,
    expectedFraxtalFrxUsdAddress: EvmAddressSchema,
    expectedFraxtalSfrxUsdAddress: EvmAddressSchema,
    expectedVaultOracleAddress: EvmAddressSchema,
    expectedVaultOracleCodeHash: EvmWordSchema,
    maxOracleToleranceSec: z.number().int().positive(),
    maxOraclePriceDeviationBps: z.number().finite().nonnegative(),
    maxRedemptionFeeBps: z.number().finite().nonnegative(),
    ...RequiredSourceUrlsFields,
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
    ...OptionalEvmRpcFields,
  })
  .strict();

const escrowBalanceIdentityCheckSchema = z
  .object({
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
    expectedAddress: EvmAddressSchema,
  })
  .strict();

const escrowBalanceSelectorReadSchema = z
  .object({
    contract: EvmAddressSchema,
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
    decimals: z.number().int().nonnegative().max(36),
    identityCheck: escrowBalanceIdentityCheckSchema.optional(),
  })
  .strict();

const escrowBalanceErc20ReadSchema = z
  .object({
    contract: EvmAddressSchema,
    erc20BalanceOf: EvmAddressSchema,
    decimals: z.number().int().nonnegative().max(36),
    identityCheck: escrowBalanceIdentityCheckSchema.optional(),
  })
  .strict();

const escrowBalancePauseCheckSchema = z
  .object({
    contract: EvmAddressSchema,
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
  })
  .strict();

const escrowBalanceSharedParamsShape = {
  slice: reserveSliceDescriptorSchema,
  ...RequiredSourceUrlsFields,
  holderEligibility: RedemptionHolderEligibilitySchema.optional(),
  settlementDelaySec: z.number().int().nonnegative().optional(),
  ...OptionalEvmRpcFields,
};

// One pinned escrow/reserve contract whose redemption capacity is readable as a
// single token-denominated view call. This original shape remains unchanged for
// existing configs. `args` are pre-encoded 32-byte ABI words and `decimals` is
// the escrowed asset's decimals, not the tracked coin's.
const escrowBalanceSingleParamsSchema = z
  .object({
    contract: EvmAddressSchema,
    selector: EvmSelectorSchema,
    args: z.array(EvmWordSchema).optional(),
    decimals: z.number().int().nonnegative().max(36),
    // Optional boolean view on the same contract; a true word withholds the
    // route instead of publishing capacity as freely redeemable.
    pausedSelector: EvmSelectorSchema.optional(),
    ...escrowBalanceSharedParamsShape,
  })
  .strict();

// Bounded aggregation for routes whose direct capacity is split across several
// reviewer-pinned views. Every item is either a selector call whose first ABI
// return word is the capacity or an ERC-20 balanceOf(holder) call. Optional
// address-returning identity checks bind a read contract to a reviewed
// dependency. The adapter withholds the whole observation if any read or
// identity check fails.
const escrowBalanceMultiParamsSchema = z
  .object({
    reads: z
      .array(z.union([escrowBalanceSelectorReadSchema, escrowBalanceErc20ReadSchema]))
      .min(1)
      .max(16),
    pauseCheck: escrowBalancePauseCheckSchema.optional(),
    ...escrowBalanceSharedParamsShape,
  })
  .strict();

const escrowBalanceParamsSchema = z.union([
  escrowBalanceSingleParamsSchema,
  escrowBalanceMultiParamsSchema,
]);

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
    mTokenSelector: EvmSelectorSchema.optional(),
    expectedMTokenAddress: z.string().optional(),
    swapFacilitySelector: EvmSelectorSchema.optional(),
    expectedSwapFacilityAddress: z.string().optional(),
    swapperAddress: z.string().optional(),
    pausedSelector: EvmSelectorSchema.optional(),
    canSwapViaPathSelector: EvmSelectorSchema.optional(),
    slice: reserveSliceDescriptorSchema,
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
    additionalDeployments: z.array(m0WrapperAdditionalDeploymentSchema).min(1).optional(),
  })
  .strict();

const liquityNativeActivePoolParamsSchema = z
  .object({
    activePoolAddress: z.string(),
    collateralLabel: z.string(),
    collateralRisk: LiveReserveRiskSchema,
    collateralDecimals: z.number().int().nonnegative(),
    debtSelector: EvmSelectorSchema,
    debtDecimals: z.number().int().nonnegative().optional(),
    collateralBalanceSelector: EvmSelectorSchema,
    priceFeedAddress: z.string(),
    priceSelector: EvmSelectorSchema,
    priceDecimals: z.number().int().nonnegative().optional(),
    troveManagerAddress: z.string(),
    tcrSelector: EvmSelectorSchema,
    mcrSelector: EvmSelectorSchema,
    borrowerOperationsAddress: z.string().optional(),
    redemptionRateSelector: EvmSelectorSchema.optional(),
    redemptionRateDecimals: z.number().int().nonnegative().optional(),
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

const originVaultAssetSchema = z
  .object({
    ...StringAddressFields,
    decimals: z.number().int().nonnegative(),
    name: z.string(),
    ...TrackedExposureFields,
  })
  .strict();

const originVaultBalancesParamsSchema = z
  .object({
    vaultAddress: z.string(),
    ...OptionalEvmRpcFields,
    assets: z.array(originVaultAssetSchema).min(1),
  })
  .strict();

const pusdVaultAssetSchema = z
  .object({
    ...StringAddressFields,
    decimals: z.number().int().nonnegative(),
  })
  .strict();

const pusdVaultParamsSchema = z
  .object({
    vaultAddress: z.string(),
    assets: z.array(pusdVaultAssetSchema).min(1),
    slice: reserveSliceDescriptorSchema,
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

const nestVaultPositionsParamsSchema = z
  .object({
    priceUrl: AbsoluteUrlSchema,
    lastPriceUpdateUrl: AbsoluteUrlSchema,
  })
  .strict();

// The credit receivable a `IdleCDOEpochVariant` vault holds is not a tracked
// asset and must never carry a `coinId`: linking it to the deposit token would
// present a single-obligor loan as that token's own reserves. The classification
// (asset class, obligor, risk factors) is reviewed curation and therefore
// config-owned; the *sizing* is always read on-chain.
const idleCdoCreditSliceSchema = z
  .object({
    sourceKey: z.string().trim().min(3),
    name: z.string().trim().min(1),
    risk: LiveReserveRiskSchema,
    assetClass: ReserveAssetClassSchema,
    issuerOrObligor: z.string().trim().min(1),
    riskFactors: z.array(ReserveRiskFactorSchema).min(1),
  })
  .strict();

// Emitted only when the CDO actually holds an unlent underlying balance. The
// adapter never synthesises this slice from NAV.
const idleCdoUnlentSliceSchema = z
  .object({
    sourceKey: z.string().trim().min(3),
    name: z.string().trim().min(1),
    risk: LiveReserveRiskSchema,
    coinId: z.string().trim().min(1),
    depType: LiveReserveDependencyTypeSchema.optional(),
    assetClass: ReserveAssetClassSchema.optional(),
    issuerOrObligor: z.string().trim().min(1).optional(),
    riskFactors: z.array(ReserveRiskFactorSchema).min(1).optional(),
    blacklistable: z.boolean().optional(),
  })
  .strict();

const idleCdoEpochVariantParamsSchema = z
  .object({
    cdoAddress: EvmAddressSchema,
    tranche: z.enum(["AA", "BB"]),
    underlyingAddress: EvmAddressSchema,
    underlyingDecimals: z.number().int().nonnegative(),
    creditSlice: idleCdoCreditSliceSchema,
    unlentSlice: idleCdoUnlentSliceSchema,
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

const makinaStrategyParamsSchema = z
  .object({
    allocationsUrl: AbsoluteUrlSchema,
    machineAddress: EvmAddressSchema,
    asyncRedeemerAddress: EvmAddressSchema.optional(),
    accountingTokenSymbol: z.string().min(1).optional(),
    accountingTokenDecimals: z.number().int().nonnegative().max(36).optional(),
    otherThresholdPct: z.number().positive().max(20).optional(),
    reconciliationTolerancePct: z.number().positive().max(5).optional(),
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
        ...StringAddressFields,
        decimals: z.number().int().nonnegative(),
      })
      .strict(),
    priceToken: z
      .object({
        chain: z.string(),
        ...StringAddressFields,
      })
      .strict()
      .optional(),
    ...TrackedExposureFields,
    priceUsd: z.number().positive().optional(),
  })
  .strict();

const evmBranchBalancesParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    branches: z.array(evmBranchBalanceBranchSchema).min(1),
    ...OptionalSourceUrlsFields,
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
    /**
     * When provided, the adapter calls `debtSelector` on `debtContract` (or the
     * first branch's holder if omitted) to fetch a system-wide debt/supply total
     * and emits `collateralizationRatio` in metadata.
     */
    debtSelector: EvmSelectorSchema.optional(),
    debtContract: z.string().optional(),
    debtDecimals: z.number().int().nonnegative().optional(),
    redemptionCapacity: z
      .object({
        kind: z.literal("honey-factory-vaults"),
        factoryAddress: EvmAddressSchema,
        expectedHoneyAddress: EvmAddressSchema,
        maxAssets: z.number().int().positive().max(32),
        stableAssets: z
          .array(
            z
              .object({
                ...EvmAddressFields,
                decimals: z.number().int().nonnegative().max(36),
              })
              .strict(),
          )
          .min(1)
          .max(32),
        ...RequiredSourceUrlsFields,
      })
      .strict()
      .superRefine((params, ctx) => {
        const addresses = new Set<string>();
        params.stableAssets.forEach((asset, index) => {
          const address = asset.address.toLowerCase();
          if (addresses.has(address)) {
            ctx.addIssue({
              code: "custom",
              path: ["stableAssets", index, "address"],
              message: `Duplicate stable asset: ${asset.address}`,
            });
          }
          addresses.add(address);
        });
      })
      .optional(),
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
    branchPriceSelector: EvmSelectorSchema.optional(),
    stabilityPoolDepositsSelector: EvmSelectorSchema,
    maxSupplyDebtDivergencePct: z.number().finite().nonnegative().optional(),
    branches: z.array(liquityV2MechanismMetricsBranchSchema).min(1),
  })
  .strict();

const liquityV2BranchesParamsSchema = evmBranchBalancesParamsSchema
  .extend({
    shutdownSelector: EvmSelectorSchema.optional(),
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
    ...StringAddressFields,
    label: z.string(),
    coinId: z.string().optional(),
    depType: LiveReserveDependencyTypeSchema.optional(),
    risk: LiveReserveRiskSchema.optional(),
  })
  .strict();

const ghoParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    gsmModules: z.array(ghoGsmModuleSchema).min(1),
    ghoTokenAddress: z.string().optional(),
  })
  .strict();

const liquityV1ParamsSchema = z
  .object({
    troveManagerAddress: z.string(),
    slice: reserveSliceDescriptorSchema,
    ...OptionalEvmRpcFields,
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
  })
  .strict();

const yamatoParamsSchema = z
  .object({
    yamatoAddress: z.string(),
    priceFeedAddress: z.string().optional(),
    slice: reserveSliceDescriptorSchema.optional(),
    ...OptionalEvmRpcFields,
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
    ...StringAddressFields,
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
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
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
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
  })
  .strict();

// Mento V3 FPMM pool (JPYm/CHFm): capacity reads the USDm balance held by the
// pool; the swap fee reads the pool's own lpFee() + protocolFee() basis points.
const mentoFpmmPoolRedemptionParamsSchema = z
  .object({
    kind: z.literal("fpmm-pool"),
    poolAddress: z.string(),
    usdmTokenAddress: z.string(),
    ...OptionalSourceUrlsFields,
    ...OptionalEvmRpcFields,
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

/** Opt-in live redemption probe for coins whose exit is a single redeemer
 *  contract paying one ERC20 out of its own float. Every bound the route's size
 *  depends on is read in the same run; any mismatch or unreadable value
 *  withholds the whole live block rather than publishing a partial route. */
const singleAssetRedemptionCapacitySchema = z
  .object({
    chain: z.string().min(1),
    /** Contract that executes the redemption and holds the payout float. */
    redeemer: EvmAddressSchema,
    /** ERC20 the route pays out; its `redeemer` balance is the capacity. */
    payoutToken: z
      .object({
        ...EvmAddressFields,
        decimals: z.number().int().min(0).max(36),
      })
      .strict(),
    /** Address getters the route must still resolve to. Pin the upgrade surface
     *  (beacon/implementation) here so a retarget stops emission. */
    identityChecks: z
      .array(
        z
          .object({
            contract: EvmAddressSchema,
            selector: EvmSelectorSchema,
            expectedAddress: EvmAddressSchema,
          })
          .strict(),
      )
      .nonempty(),
    /** Per-day cap, read as `limitSelector - usedSelector(currentDay)`. */
    dailyLimit: z
      .object({
        limitSelector: EvmSelectorSchema,
        /** Takes the `block.timestamp / 86400` day index as its only argument. */
        usedSelector: EvmSelectorSchema,
        decimals: z.number().int().min(0).max(36),
      })
      .strict()
      .optional(),
    /** Getter returning the redemption fee already denominated in bps. */
    feeBpsSelector: EvmSelectorSchema.optional(),
    holderEligibility: RedemptionHolderEligibilitySchema,
    ...NonemptySourceUrlsFields,
  })
  .strict();

const singleAssetParamsSchema = z
  .object({
    label: z.string(),
    ...TrackedExposureFields,
    ...OptionalEvmRpcFields,
    probe: singleAssetProbeSchema.optional(),
    reserveProbe: singleAssetProbeSchema.optional(),
    supplyProbe: singleAssetProbeSchema.optional(),
    timestampProbe: singleAssetProbeSchema.optional(),
    reserveSourceLabel: z.string().optional(),
    redemptionRateProbe: redemptionRateProbeSchema.optional(),
    redemptionCapacity: singleAssetRedemptionCapacitySchema.optional(),
  })
  .strict();

const parallelizerBalanceAssetSchema = z
  .object({
    ...EvmAddressFields,
    decimals: z.number().int().nonnegative().max(36),
    name: z.string().min(1),
    ...TrackedExposureFields,
  })
  .strict();

const parallelizerBalanceDeploymentSchema = z
  .object({
    chain: z.string().min(1),
    vaultAddress: EvmAddressSchema,
    expectedTokenP: EvmAddressSchema,
    rpcUrl: AbsoluteUrlSchema,
    fallbackRpcUrl: AbsoluteUrlSchema.optional(),
    assets: z.array(parallelizerBalanceAssetSchema).min(1),
  })
  .strict();

const parallelizerBalancesParamsSchema = z
  .object({
    deployments: z.array(parallelizerBalanceDeploymentSchema).min(1).max(8),
    ...RequiredSourceUrlsFields,
    holderEligibility: RedemptionHolderEligibilitySchema.optional(),
    settlementDelaySec: z.number().int().nonnegative().optional(),
  })
  .strict();

const abracadabraCauldronSchema = z
  .object({
    ...StringAddressFields,
    collateralSymbol: z.string(),
    collateralAddress: z.string(),
    collateralDecimals: z.number().int().nonnegative(),
    ...TrackedExposureFields,
    // Reserved for future V2/V3/V4 selector nuance; currently unused by the adapter.
    version: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  })
  .strict();

const abracadabraParamsSchema = z
  .object({
    ...OptionalEvmRpcFields,
    // BentoBox / DegenBox contract that backs the configured cauldrons. Used to
    // convert per-cauldron `totalCollateralShare` into underlying token amounts
    // via `toAmount(token, share, false)`.
    bentoBoxAddress: z.string(),
    cauldrons: z.array(abracadabraCauldronSchema).min(1),
  })
  .strict();

const astherusEarnWrapperParamsSchema = z
  .object({
    earnAddress: EvmAddressSchema,
    expectedUnderlyingAddress: EvmAddressSchema,
    expectedShareAddress: EvmAddressSchema,
    underlyingDecimals: z.number().int().nonnegative().max(36),
    shareDecimals: z.number().int().nonnegative().max(36),
    slice: reserveSliceDescriptorSchema,
    ...OptionalEvmRpcFields,
  })
  .strict();

// A 100% parent-inheritance claim must not be repointable by a catalog edit alone.
// A genuine Initia object migration therefore requires a code change and review.
const initiaWrapperVaultParamsSchema = z
  .object({
    lcdUrl: AbsoluteUrlSchema,
    iusdDenom: z.literal("move/6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e"),
    iusdMetadataAddress: z.literal("0x6c69733a9e722f3660afb524f89fce957801fa7e4408b8ef8fe89db9627b570e"),
    vaultOwnerAddress: z.literal("0xfd6a07594842ac5d7501ff55243aff06e4f991f320828be05a4590970145e90a"),
    ausd0MetadataAddress: z.literal("0x8078cf9fee50e15069402e9d1d9db70b28fc0d5197d79e8a2b41e2ade432efef"),
    decimals: z.literal(6),
    slice: reserveSliceDescriptorSchema.extend({
      coinId: z.literal("ausd-agora"),
      depType: z.literal("wrapper"),
    }),
  })
  .strict();

const stoneyieldRouterPoolParamsSchema = z
  .object({
    slice: reserveSliceDescriptorSchema,
    stusdAddress: EvmAddressSchema,
    usdcAddress: EvmAddressSchema,
    susdcAddress: EvmAddressSchema,
    routerAddress: EvmAddressSchema,
    venusVaultAddress: EvmAddressSchema,
    venusVTokenAddress: EvmAddressSchema,
    ...OptionalEvmRpcFields,
  })
  .strict();

export const LIVE_RESERVE_PARAM_SCHEMAS = {
  none: noParamsSchema,
  abracadabra: abracadabraParamsSchema,
  astherusEarnWrapper: astherusEarnWrapperParamsSchema,
  accountable: accountableParamsSchema,
  attestationPdfIndex: attestationPdfIndexParamsSchema,
  audxAssurance: audxAssuranceParamsSchema,
  blastUsdbYieldManager: blastUsdbYieldManagerParamsSchema,
  btcfi: btcfiParamsSchema,
  capVault: capVaultParamsSchema,
  chainlinkNav: chainlinkNavParamsSchema,
  chronicleNav: chronicleNavParamsSchema,
  chainlinkPor: chainlinkPorParamsSchema,
  circleTransparency: circleTransparencyParamsSchema,
  collateralPositions: collateralPositionsParamsSchema,
  curatedValidated: curatedValidatedParamsSchema,
  erc4626SingleAsset: erc4626SingleAssetParamsSchema,
  europAssurance: europAssuranceParamsSchema,
  escrowBalance: escrowBalanceParamsSchema,
  evmBranchBalances: evmBranchBalancesParamsSchema,
  fraxFpiCollateral: fraxFpiCollateralParamsSchema,
  fx: fxParamsSchema,
  gho: ghoParamsSchema,
  initiaWrapperVault: initiaWrapperVaultParamsSchema,
  jupusd: jupusdParamsSchema,
  liquityNativeActivePool: liquityNativeActivePoolParamsSchema,
  liquityV1: liquityV1ParamsSchema,
  liquityV2Branches: liquityV2BranchesParamsSchema,
  m0WrapperUnderlying: m0WrapperUnderlyingParamsSchema,
  makinaStrategy: makinaStrategyParamsSchema,
  mento: mentoParamsSchema,
  nestVaultPositions: nestVaultPositionsParamsSchema,
  originVaultBalances: originVaultBalancesParamsSchema,
  parallelizerBalances: parallelizerBalancesParamsSchema,
  pusdVault: pusdVaultParamsSchema,
  quantozTransparency: quantozTransparencyParamsSchema,
  reserveProtocolDtf: reserveProtocolDtfParamsSchema,
  resupplyPairs: resupplyPairsParamsSchema,
  sgForgeCoinvertible: sgForgeCoinvertibleParamsSchema,
  stoneyieldRouterPool: stoneyieldRouterPoolParamsSchema,
  singleAsset: singleAssetParamsSchema,
  spikoApi: spikoApiParamsSchema,
  superstateLiquidity: superstateLiquidityParamsSchema,
  straitsxAssurance: straitsxAssuranceParamsSchema,
  usdgoAssurance: usdgoAssuranceParamsSchema,
  mocV3Buckets: mocV3BucketsParamsSchema,
  tetherTransparency: tetherTransparencyParamsSchema,
  unitedPor: unitedPorParamsSchema,
  usd1BundleOracle: usd1BundleOracleParamsSchema,
  hiveHbdProtocol: hiveHbdProtocolParamsSchema,
  idleCdoEpochVariant: idleCdoEpochVariantParamsSchema,
  usdaiHub: usdaiHubParamsSchema,
  xdaiBridge: xdaiBridgeParamsSchema,
  yamato: yamatoParamsSchema,
} as const;


export * from "../types/live-reserve-adapter-policy";
