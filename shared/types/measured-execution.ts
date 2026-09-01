import { z } from "zod";

import { ExitRouteCapacityPointSchema, ExitRouteObservationHistorySchema } from "./exit-route";

export const DEX_MEASURED_EXECUTION_SCHEMA_VERSION = "dex-measured-execution-v1" as const;
export const DEX_MEASURED_TARGET_SCHEMA_VERSION = "dex-measured-target-v1" as const;
export const DEX_EXECUTION_PROFILE_SCHEMA_VERSION = "dex-execution-profile-v2" as const;
export const DEX_EXECUTION_TARGET_SCHEMA_VERSION = "dex-execution-target-v2" as const;
export const DEX_EXECUTION_PERSISTENCE_MODE = "v1-compatible-dual-read" as const;
export const DEX_MEASURED_MAX_COST_BPS = 200;
export const DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO = 1.02;
const DEX_MEASURED_MARGINAL_NOTIONAL_USD = 1_000;
export const DEX_MEASURED_CAPACITY_NOTIONALS_USD = [100_000, 1_000_000, 10_000_000, 25_000_000] as const;
// Both bounds must cover the two-hour score-bearing Liquidity Score publication
// cadence (even-hour :16): the half-hourly V9 input preparation sees the current
// published measured window at up to ~96 minutes old, so a tighter bound derates
// confidence on alternate score runs even though the evidence is on schedule.
//
// The bound is deliberately one publication cycle WIDER than that cadence. At a
// two-hour bound the expiry ceiling equalled the republication period, so a
// single delayed, skipped, or degraded even-hour `:16` publication aged every
// measured profile past expiry at once; each expired route then left the exit
// capacity denominator outright (see `routeExclusionReason`), which is what made
// anchor grades oscillate for producer-schedule reasons rather than market ones.
// Three hours keeps one whole cycle of slack so a single missed publication is
// survivable, and `GENERATION_RETENTION_SEC` stays an hour above this bound so a
// profile can never read fresh after its backing rows were pruned.
export const DEX_MEASURED_FRESHNESS_MAX_SEC = 3 * 60 * 60;
export const DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC = 3 * 60 * 60;
const DEX_MEASURED_MATURE_SUCCESSFUL_CYCLE_COUNT = 2;

const CanonicalEvmAddressSchema = z.string().regex(/^0x[a-f0-9]{40}$/);
const CanonicalBytes32Schema = z.string().regex(/^0x[a-f0-9]{64}$/);
const CanonicalSolanaIdentitySchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/);

export const DEX_EXACT_QUOTE_ADAPTER_IDS = {
  quoterV2: "evm-quoter-v2",
  uniswapV4: "evm-uniswap-v4",
  curveCryptoSwap: "evm-curve-cryptoswap",
  curveStableSwap: "evm-curve-stableswap",
  curveStableSwapNg: "evm-curve-stableswap-ng",
  curveComposite: "evm-curve-composite",
  evmV2: "evm-v2-reserve-exact",
  solanaClmm: "solana-clmm",
} as const;
const DEX_EXACT_QUOTE_ADAPTER_ID_VALUES = Object.values(
  DEX_EXACT_QUOTE_ADAPTER_IDS,
) as [DexExactQuoteAdapterId, ...DexExactQuoteAdapterId[]];

export type DexExactQuoteAdapterId =
  (typeof DEX_EXACT_QUOTE_ADAPTER_IDS)[keyof typeof DEX_EXACT_QUOTE_ADAPTER_IDS];

export interface DexRequestBudget {
  readonly maxRequests: number;
  readonly deadlineMs: number;
  readonly remainingRequests: number;
  tryConsume(count?: number): boolean;
}

export const DEX_MEASURED_ADAPTER_PROFILE_IDS = {
  curveStableSwap: "curve-stableswap-main-registry-get-dy-v1",
  curveStableSwapNg: "curve-stableswap-ng-factory-get-dy-v2",
  curveRateBearing: "curve-stableswap-ng-rate-bearing-get-dy-v1",
  curveMetapool: "curve-stableswap-ng-metapool-underlying-v1",
} as const;

const DEX_CURVE_STABLESWAP_ADAPTER_PROFILE_IDS = new Set<string>(
  Object.values(DEX_MEASURED_ADAPTER_PROFILE_IDS),
);

export function getDexMeasuredExecutionFreshnessMaxSec(adapterProfileId: string): number {
  return DEX_CURVE_STABLESWAP_ADAPTER_PROFILE_IDS.has(adapterProfileId)
    ? DEX_CURVE_STABLESWAP_MEASURED_FRESHNESS_MAX_SEC
    : DEX_MEASURED_FRESHNESS_MAX_SEC;
}

export const DexMeasuredExecutionObservationHistorySchema = ExitRouteObservationHistorySchema
  .superRefine((history, ctx) => {
    if (history.conservativeCapacityCurve.length !== DEX_MEASURED_CAPACITY_NOTIONALS_USD.length) {
      ctx.addIssue({
        code: "custom",
        path: ["conservativeCapacityCurve"],
        message: `Measured observation history requires ${DEX_MEASURED_CAPACITY_NOTIONALS_USD.length} capacity points`,
      });
    }
  });
export type DexMeasuredExecutionObservationHistory = z.infer<
  typeof DexMeasuredExecutionObservationHistorySchema
>;

export function isDexMeasuredExecutionObservationHistoryMature(
  history: DexMeasuredExecutionObservationHistory | null | undefined,
): boolean {
  return (history?.successfulObservationCount ?? 0) >= DEX_MEASURED_MATURE_SUCCESSFUL_CYCLE_COUNT;
}

const DexMeasuredExecutionTokenSchema = z.object({
  address: CanonicalEvmAddressSchema,
  symbol: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(255),
  referencePriceUsd: z.number().finite().positive(),
  trackedAssetId: z.string().min(1).optional(),
});

/**
 * Adapter-neutral description of one retained-pool execution direction. The
 * adapter profile id selects protocol-specific calldata outside this schema.
 */
export const DexMeasuredExecutionTargetSchema = z.object({
  schemaVersion: z.literal(DEX_MEASURED_TARGET_SCHEMA_VERSION),
  targetId: z.string().min(1).max(512),
  stablecoinId: z.string().min(1),
  adapterProfileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  protocol: z.string().min(1).max(64),
  chain: z.string().min(1).max(64),
  poolId: z.string().min(1).max(128),
  poolTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8).optional(),
  tokenIn: DexMeasuredExecutionTokenSchema,
  tokenOut: DexMeasuredExecutionTokenSchema,
  feePips: z.number().int().min(0).max(1_000_000).optional(),
  tickSpacing: z.number().int().min(1).max(8_388_607).optional(),
  hookAddress: CanonicalEvmAddressSchema.optional(),
  retainedTvlUsd: z.number().finite().positive(),
  retainedPoolPriceUsd: z.number().finite().positive(),
  capturedAt: z.number().int().nonnegative(),
});
export type DexMeasuredExecutionTarget = z.infer<typeof DexMeasuredExecutionTargetSchema>;

const DexMeasuredExecutionQuotePointProofSchema = z.object({
  amountInRaw: z.string().regex(/^[1-9][0-9]*$/),
  amountOutRaw: z.string().regex(/^[0-9]+$/),
  callData: z.string().regex(/^0x[0-9a-f]+$/),
  returnData: z.string().regex(/^0x[0-9a-f]*$/),
  inputUsd: z.number().finite().positive(),
  outputUsd: z.number().finite().nonnegative(),
  costBps: z.number().finite().nonnegative(),
  passesCostBound: z.boolean(),
  /** A decoded Multicall inner failure at this exact input, not an RPC failure. */
  reverted: z.literal(true).optional(),
});
export type DexMeasuredExecutionQuotePointProof = z.infer<typeof DexMeasuredExecutionQuotePointProofSchema>;

const DexMeasuredExecutionPoolBindingProofSchema = z.object({
  factoryAddress: CanonicalEvmAddressSchema,
  factoryCodeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
  resolvedPoolAddress: CanonicalEvmAddressSchema,
  callData: z.string().regex(/^0x[0-9a-f]+$/),
  returnData: z.string().regex(/^0x[0-9a-f]+$/),
});
export type DexMeasuredExecutionPoolBindingProof = z.infer<typeof DexMeasuredExecutionPoolBindingProofSchema>;

const DexMeasuredExecutionRegistryBindingProofSchema = z.object({
  registryAddress: CanonicalEvmAddressSchema,
  registryCodeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
  registeredPoolAddress: CanonicalEvmAddressSchema,
  lpTokenAddress: CanonicalEvmAddressSchema,
  poolTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8),
  lpTokenCallData: z.string().regex(/^0x[0-9a-f]+$/),
  lpTokenReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  registryCoinsCallData: z.string().regex(/^0x[0-9a-f]+$/),
  registryCoinsReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  poolCoinsProof: z.array(z.object({
    index: z.number().int().min(0).max(7),
    callData: z.string().regex(/^0x[0-9a-f]+$/),
    returnData: z.string().regex(/^0x[0-9a-f]+$/),
  })).min(2).max(8),
  tokenDecimalsProof: z.array(z.object({
    tokenAddress: CanonicalEvmAddressSchema,
    decimals: z.number().int().min(0).max(255),
    callData: z.string().regex(/^0x[0-9a-f]+$/),
    returnData: z.string().regex(/^0x[0-9a-f]+$/),
  })).min(2).max(8),
});
export type DexMeasuredExecutionRegistryBindingProof = z.infer<
  typeof DexMeasuredExecutionRegistryBindingProofSchema
>;

const DexMeasuredExecutionStableSwapNgFactoryBindingProofSchema = z.object({
  blockNumber: z.number().int().nonnegative(),
  blockHash: z.string().regex(/^0x[a-f0-9]{64}$/),
  blockCommitment: z.literal("finalized"),
  factoryAddress: CanonicalEvmAddressSchema,
  factoryCodeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
  poolIndex: z.number().int().nonnegative(),
  registeredPoolAddress: CanonicalEvmAddressSchema,
  poolTokenAddresses: z.array(CanonicalEvmAddressSchema).length(2),
  poolListCallData: z.string().regex(/^0x[0-9a-f]+$/),
  poolListReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  factoryCoinsCallData: z.string().regex(/^0x[0-9a-f]+$/),
  factoryCoinsReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  poolCoinsProof: z.array(z.object({
    index: z.number().int().min(0).max(1),
    callData: z.string().regex(/^0x[0-9a-f]+$/),
    returnData: z.string().regex(/^0x[0-9a-f]+$/),
  })).length(2),
  tokenDecimalsProof: z.array(z.object({
    tokenAddress: CanonicalEvmAddressSchema,
    decimals: z.number().int().min(0).max(255),
    callData: z.string().regex(/^0x[0-9a-f]+$/),
    returnData: z.string().regex(/^0x[0-9a-f]+$/),
  })).length(2),
});
export type DexMeasuredExecutionStableSwapNgFactoryBindingProof = z.infer<
  typeof DexMeasuredExecutionStableSwapNgFactoryBindingProofSchema
>;

const DexMeasuredExecutionCurveCompositeProofSchema = z.object({
  blockNumber: z.number().int().nonnegative(),
  blockHash: CanonicalBytes32Schema,
  blockCommitment: z.literal("finalized"),
  factoryAddress: CanonicalEvmAddressSchema,
  factoryCodeHash: CanonicalBytes32Schema,
  poolIndex: z.number().int().nonnegative(),
  registeredPoolAddress: CanonicalEvmAddressSchema,
  poolCodeHash: CanonicalBytes32Schema,
  implementationAddress: CanonicalEvmAddressSchema,
  implementationCodeHash: CanonicalBytes32Schema,
  quoteFunction: z.enum(["get_dy", "get_dy_underlying"]),
  poolTokenAddresses: z.array(CanonicalEvmAddressSchema).length(2),
  executionTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8),
  calls: z.array(z.object({
    role: z.string().regex(/^[a-z0-9-]{1,64}$/),
    target: CanonicalEvmAddressSchema,
    callData: z.string().regex(/^0x[0-9a-f]+$/),
    returnData: z.string().regex(/^0x[0-9a-f]+$/),
  })).min(5).max(32),
  rateProvider: z.object({
    kind: z.literal("erc4626"),
    tokenAddress: CanonicalEvmAddressSchema,
    providerAddress: CanonicalEvmAddressSchema,
    providerCodeHash: CanonicalBytes32Schema,
    underlyingAddress: CanonicalEvmAddressSchema,
    observedRate: z.string().regex(/^[1-9][0-9]*$/),
  }).optional(),
  metapool: z.object({
    basePoolAddress: CanonicalEvmAddressSchema,
    basePoolCodeHash: CanonicalBytes32Schema,
    basePoolTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8),
  }).optional(),
});
export type DexMeasuredExecutionCurveCompositeProof = z.infer<
  typeof DexMeasuredExecutionCurveCompositeProofSchema
>;

const DexMeasuredExecutionUniswapV4PoolProofSchema = z.object({
  blockNumber: z.number().int().nonnegative(),
  poolId: CanonicalBytes32Schema,
  poolManagerAddress: CanonicalEvmAddressSchema,
  poolManagerCodeHash: CanonicalBytes32Schema,
  stateViewAddress: CanonicalEvmAddressSchema,
  stateViewCodeHash: CanonicalBytes32Schema,
  quoterPoolManagerCallData: z.string().regex(/^0x[0-9a-f]+$/),
  quoterPoolManagerReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  stateViewPoolManagerCallData: z.string().regex(/^0x[0-9a-f]+$/),
  stateViewPoolManagerReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  slot0CallData: z.string().regex(/^0x[0-9a-f]+$/),
  slot0ReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  liquidityCallData: z.string().regex(/^0x[0-9a-f]+$/),
  liquidityReturnData: z.string().regex(/^0x[0-9a-f]+$/),
  sqrtPriceX96: z.string().regex(/^[1-9][0-9]*$/),
  tick: z.number().int().min(-8_388_608).max(8_388_607),
  protocolFee: z.number().int().min(0).max(0xffffff),
  lpFee: z.number().int().min(0).max(0xffffff),
  liquidity: z.string().regex(/^[1-9][0-9]*$/),
});
export type DexMeasuredExecutionUniswapV4PoolProof = z.infer<
  typeof DexMeasuredExecutionUniswapV4PoolProofSchema
>;

export const DexMeasuredExecutionProfileSchema = z.object({
  schemaVersion: z.literal(DEX_MEASURED_EXECUTION_SCHEMA_VERSION),
  kind: z.literal("measured-executable-depth"),
  targetId: z.string().min(1).max(512),
  targetGenerationId: z.string().min(1).max(128),
  quoteGenerationId: z.string().min(1).max(128),
  adapterProfileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  protocol: z.string().min(1).max(64),
  chain: z.string().min(1).max(64),
  poolId: z.string().min(1).max(128),
  poolTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8).optional(),
  tokenIn: DexMeasuredExecutionTokenSchema,
  tokenOut: DexMeasuredExecutionTokenSchema,
  feePips: z.number().int().min(0).max(1_000_000).optional(),
  tickSpacing: z.number().int().min(1).max(8_388_607).optional(),
  hookAddress: CanonicalEvmAddressSchema.optional(),
  retainedTvlUsdAtQuote: z.number().finite().positive(),
  retainedPoolPriceUsdAtQuote: z.number().finite().positive(),
  quotedAt: z.number().int().nonnegative(),
  blockNumber: z.number().int().nonnegative(),
  executionEndpoint: z.object({
    address: CanonicalEvmAddressSchema,
    codeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
  }),
  poolBindingProof: DexMeasuredExecutionPoolBindingProofSchema.optional(),
  registryBindingProof: DexMeasuredExecutionRegistryBindingProofSchema.optional(),
  stableSwapNgFactoryBindingProof: DexMeasuredExecutionStableSwapNgFactoryBindingProofSchema.optional(),
  curveCompositeProof: DexMeasuredExecutionCurveCompositeProofSchema.optional(),
  uniswapV4PoolProof: DexMeasuredExecutionUniswapV4PoolProofSchema.optional(),
  maxCostBps: z.literal(DEX_MEASURED_MAX_COST_BPS),
  marginalOutputRatio: z.number().finite().nonnegative(),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).length(DEX_MEASURED_CAPACITY_NOTIONALS_USD.length),
  quoteProof: z.array(DexMeasuredExecutionQuotePointProofSchema).min(1).max(16),
});
export type DexMeasuredExecutionProfile = z.infer<typeof DexMeasuredExecutionProfileSchema>;

const DexExecutionIdentityV2Schema = z.object({
  stablecoinId: z.string().min(1),
  protocol: z.string().min(1).max(64),
  chain: z.string().min(1).max(64),
  poolId: z.string().min(1).max(256),
  tokenIn: z.object({
    identity: z.string().min(1).max(128),
    symbol: z.string().min(1).max(64),
    decimals: z.number().int().min(0).max(255),
    referencePriceUsd: z.number().finite().positive(),
    trackedAssetId: z.string().min(1).optional(),
  }),
  tokenOut: z.object({
    identity: z.string().min(1).max(128),
    symbol: z.string().min(1).max(64),
    decimals: z.number().int().min(0).max(255),
    referencePriceUsd: z.number().finite().positive(),
    trackedAssetId: z.string().min(1).optional(),
  }),
});

const DexExecutionTargetEvmPayloadV2Schema = z.object({
  platform: z.literal("evm"),
  poolIdentity: z.union([CanonicalEvmAddressSchema, CanonicalBytes32Schema]),
  poolTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8),
  feePips: z.number().int().min(0).max(1_000_000).optional(),
  tickSpacing: z.number().int().min(1).max(8_388_607).optional(),
  hookAddress: CanonicalEvmAddressSchema.optional(),
  legacyV1: DexMeasuredExecutionTargetSchema.optional(),
});

const DexExecutionTargetSolanaPayloadV2Schema = z.object({
  platform: z.literal("solana"),
  poolAccount: CanonicalSolanaIdentitySchema,
  programId: CanonicalSolanaIdentitySchema,
  tokenMintIn: CanonicalSolanaIdentitySchema,
  tokenMintOut: CanonicalSolanaIdentitySchema,
  stateAccounts: z.array(CanonicalSolanaIdentitySchema).min(1).max(32),
  tickArrayAccounts: z.array(CanonicalSolanaIdentitySchema).max(64),
});

export const DexExecutionTargetV2Schema = z.object({
  schemaVersion: z.literal(DEX_EXECUTION_TARGET_SCHEMA_VERSION),
  targetId: z.string().min(1).max(512),
  adapterId: z.enum(DEX_EXACT_QUOTE_ADAPTER_ID_VALUES),
  profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  identity: DexExecutionIdentityV2Schema,
  retainedTvlUsd: z.number().finite().positive(),
  retainedPoolPriceUsd: z.number().finite().positive(),
  capturedAt: z.number().int().nonnegative(),
  payload: z.discriminatedUnion("platform", [
    DexExecutionTargetEvmPayloadV2Schema,
    DexExecutionTargetSolanaPayloadV2Schema,
  ]),
});
export type DexExecutionTargetV2 = z.infer<typeof DexExecutionTargetV2Schema>;

const DexExecutionProfileEvmPayloadV2Schema = z.object({
  platform: z.literal("evm"),
  blockNumber: z.number().int().nonnegative(),
  blockHash: CanonicalBytes32Schema.optional(),
  executionEndpoint: z.object({
    address: CanonicalEvmAddressSchema,
    codeHash: CanonicalBytes32Schema,
  }),
  callProof: z.array(z.object({
    target: CanonicalEvmAddressSchema,
    callData: z.string().regex(/^0x[0-9a-f]+$/),
    returnData: z.string().regex(/^0x[0-9a-f]*$/),
  })).min(1).max(64),
  legacyV1: DexMeasuredExecutionProfileSchema.optional(),
});

const DexExecutionProfileSolanaPayloadV2Schema = z.object({
  platform: z.literal("solana"),
  slot: z.number().int().nonnegative(),
  blockHash: CanonicalSolanaIdentitySchema,
  programId: CanonicalSolanaIdentitySchema,
  poolAccount: CanonicalSolanaIdentitySchema,
  stateAccounts: z.array(CanonicalSolanaIdentitySchema).min(1).max(32),
  tickArrayAccounts: z.array(CanonicalSolanaIdentitySchema).max(64),
  accountProof: z.array(z.object({
    account: CanonicalSolanaIdentitySchema,
    owner: CanonicalSolanaIdentitySchema,
    dataHash: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1).max(96),
});

export const DexExecutionProfileV2Schema = z.object({
  schemaVersion: z.literal(DEX_EXECUTION_PROFILE_SCHEMA_VERSION),
  kind: z.literal("measured-executable-depth"),
  targetId: z.string().min(1).max(512),
  targetGenerationId: z.string().min(1).max(128),
  quoteGenerationId: z.string().min(1).max(128),
  adapterId: z.enum(DEX_EXACT_QUOTE_ADAPTER_ID_VALUES),
  profileId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  identity: DexExecutionIdentityV2Schema,
  retainedTvlUsdAtQuote: z.number().finite().positive(),
  retainedPoolPriceUsdAtQuote: z.number().finite().positive(),
  quotedAt: z.number().int().nonnegative(),
  maxCostBps: z.literal(DEX_MEASURED_MAX_COST_BPS),
  demandedInputAmountsUsd: z.array(z.number().finite().positive()).min(1).max(16),
  outputAmountsUsd: z.array(z.number().finite().nonnegative()).min(1).max(16),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).length(DEX_MEASURED_CAPACITY_NOTIONALS_USD.length),
  observationHistory: DexMeasuredExecutionObservationHistorySchema.optional(),
  payload: z.discriminatedUnion("platform", [
    DexExecutionProfileEvmPayloadV2Schema,
    DexExecutionProfileSolanaPayloadV2Schema,
  ]),
}).superRefine((profile, ctx) => {
  if (profile.demandedInputAmountsUsd.length !== profile.outputAmountsUsd.length) {
    ctx.addIssue({
      code: "custom",
      path: ["outputAmountsUsd"],
      message: "Every demanded input amount requires one exact output amount",
    });
  }
});
export type DexExecutionProfileV2 = z.infer<typeof DexExecutionProfileV2Schema>;

export const DexExecutionTargetEnvelopeSchema = z.union([
  DexMeasuredExecutionTargetSchema,
  DexExecutionTargetV2Schema,
]);
export const DexExecutionProfileEnvelopeSchema = z.union([
  DexMeasuredExecutionProfileSchema,
  DexExecutionProfileV2Schema,
]);
export type DexExecutionTargetEnvelope = z.infer<typeof DexExecutionTargetEnvelopeSchema>;
export type DexExecutionProfileEnvelope = z.infer<typeof DexExecutionProfileEnvelopeSchema>;

function adapterIdForV1Profile(profileId: string): DexExactQuoteAdapterId {
  if (
    profileId === "uniswap-v3-quoter-v2" ||
    profileId === "pancakeswap-v3-quoter-v2" ||
    profileId === "aerodrome-slipstream-quoter-v2"
  ) return DEX_EXACT_QUOTE_ADAPTER_IDS.quoterV2;
  if (profileId === "uniswap-v4-hook-free-quoter-v1") return DEX_EXACT_QUOTE_ADAPTER_IDS.uniswapV4;
  if (profileId === "curve-cryptoswap-get-dy-v1") return DEX_EXACT_QUOTE_ADAPTER_IDS.curveCryptoSwap;
  if (profileId === DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwap) {
    return DEX_EXACT_QUOTE_ADAPTER_IDS.curveStableSwap;
  }
  if (profileId === DEX_MEASURED_ADAPTER_PROFILE_IDS.curveStableSwapNg) {
    return DEX_EXACT_QUOTE_ADAPTER_IDS.curveStableSwapNg;
  }
  return DEX_EXACT_QUOTE_ADAPTER_IDS.curveComposite;
}

function identityV2FromV1(input: DexMeasuredExecutionTarget | DexMeasuredExecutionProfile) {
  const stablecoinId = "stablecoinId" in input ? input.stablecoinId : input.tokenIn.trackedAssetId;
  if (!stablecoinId) throw new Error(`V1 measured execution row has no tracked input identity: ${input.targetId}`);
  return {
    stablecoinId,
    protocol: input.protocol,
    chain: input.chain,
    poolId: input.poolId,
    tokenIn: { ...input.tokenIn, identity: input.tokenIn.address },
    tokenOut: { ...input.tokenOut, identity: input.tokenOut.address },
  };
}

/** Lossless V1 wrapper used by dual readers; active persistence remains V1. */
export function projectDexMeasuredExecutionTargetToV2(input: DexMeasuredExecutionTarget): DexExecutionTargetV2 {
  const target = DexMeasuredExecutionTargetSchema.parse(input);
  return DexExecutionTargetV2Schema.parse({
    schemaVersion: DEX_EXECUTION_TARGET_SCHEMA_VERSION,
    targetId: target.targetId,
    adapterId: adapterIdForV1Profile(target.adapterProfileId),
    profileId: target.adapterProfileId,
    identity: identityV2FromV1(target),
    retainedTvlUsd: target.retainedTvlUsd,
    retainedPoolPriceUsd: target.retainedPoolPriceUsd,
    capturedAt: target.capturedAt,
    payload: {
      platform: "evm",
      poolIdentity: target.poolId.slice(target.poolId.lastIndexOf(":") + 1),
      poolTokenAddresses: target.poolTokenAddresses ?? [target.tokenIn.address, target.tokenOut.address],
      ...(target.feePips != null ? { feePips: target.feePips } : {}),
      ...(target.tickSpacing != null ? { tickSpacing: target.tickSpacing } : {}),
      ...(target.hookAddress != null ? { hookAddress: target.hookAddress } : {}),
      legacyV1: target,
    },
  });
}

/** Lossless V1 wrapper used by dual readers; active persistence remains V1. */
export function projectDexMeasuredExecutionProfileToV2(input: DexMeasuredExecutionProfile): DexExecutionProfileV2 {
  const profile = DexMeasuredExecutionProfileSchema.parse(input);
  return DexExecutionProfileV2Schema.parse({
    schemaVersion: DEX_EXECUTION_PROFILE_SCHEMA_VERSION,
    kind: profile.kind,
    targetId: profile.targetId,
    targetGenerationId: profile.targetGenerationId,
    quoteGenerationId: profile.quoteGenerationId,
    adapterId: adapterIdForV1Profile(profile.adapterProfileId),
    profileId: profile.adapterProfileId,
    identity: identityV2FromV1(profile),
    retainedTvlUsdAtQuote: profile.retainedTvlUsdAtQuote,
    retainedPoolPriceUsdAtQuote: profile.retainedPoolPriceUsdAtQuote,
    quotedAt: profile.quotedAt,
    maxCostBps: profile.maxCostBps,
    demandedInputAmountsUsd: profile.quoteProof.map((point) => point.inputUsd),
    outputAmountsUsd: profile.quoteProof.map((point) => point.outputUsd),
    capacityCurve: profile.capacityCurve,
    payload: {
      platform: "evm",
      blockNumber: profile.blockNumber,
      executionEndpoint: profile.executionEndpoint,
      callProof: profile.quoteProof.map((point) => ({
        target: profile.executionEndpoint.address,
        callData: point.callData,
        returnData: point.returnData,
      })),
      legacyV1: profile,
    },
  });
}

export function projectDexExecutionTargetToV1(input: DexExecutionTargetEnvelope): DexMeasuredExecutionTarget | null {
  if (input.schemaVersion === DEX_MEASURED_TARGET_SCHEMA_VERSION) return input;
  return input.payload.platform === "evm" ? input.payload.legacyV1 ?? null : null;
}

export function projectDexExecutionProfileToV1(input: DexExecutionProfileEnvelope): DexMeasuredExecutionProfile | null {
  if (input.schemaVersion === DEX_MEASURED_EXECUTION_SCHEMA_VERSION) return input;
  return input.payload.platform === "evm" ? input.payload.legacyV1 ?? null : null;
}

/** Public, proof-free projection retained on DEX pool rows. */
export const DexMeasuredExecutionPublicProfileSchema = DexMeasuredExecutionProfileSchema.omit({
  quoteProof: true,
  poolBindingProof: true,
  registryBindingProof: true,
  stableSwapNgFactoryBindingProof: true,
  curveCompositeProof: true,
  uniswapV4PoolProof: true,
}).extend({
  observationHistory: DexMeasuredExecutionObservationHistorySchema.optional(),
  poolProvenance: z.object({
    factoryAddress: CanonicalEvmAddressSchema,
    factoryCodeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    resolvedPoolAddress: CanonicalEvmAddressSchema,
  }).optional(),
  registryProvenance: z.object({
    registryAddress: CanonicalEvmAddressSchema,
    registryCodeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    registeredPoolAddress: CanonicalEvmAddressSchema,
    lpTokenAddress: CanonicalEvmAddressSchema,
    poolTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8),
  }).optional(),
  stableSwapNgFactoryProvenance: z.object({
    blockNumber: z.number().int().nonnegative(),
    blockHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    blockCommitment: z.literal("finalized"),
    factoryAddress: CanonicalEvmAddressSchema,
    factoryCodeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    poolIndex: z.number().int().nonnegative(),
    registeredPoolAddress: CanonicalEvmAddressSchema,
    poolTokenAddresses: z.array(CanonicalEvmAddressSchema).length(2),
  }).optional(),
  curveCompositeProvenance: z.object({
    blockNumber: z.number().int().nonnegative(),
    blockHash: CanonicalBytes32Schema,
    factoryAddress: CanonicalEvmAddressSchema,
    factoryCodeHash: CanonicalBytes32Schema,
    registeredPoolAddress: CanonicalEvmAddressSchema,
    implementationAddress: CanonicalEvmAddressSchema,
    implementationCodeHash: CanonicalBytes32Schema,
    quoteFunction: z.enum(["get_dy", "get_dy_underlying"]),
    poolTokenAddresses: z.array(CanonicalEvmAddressSchema).length(2),
    executionTokenAddresses: z.array(CanonicalEvmAddressSchema).min(2).max(8),
    rateProviderAddress: CanonicalEvmAddressSchema.optional(),
    basePoolAddress: CanonicalEvmAddressSchema.optional(),
  }).optional(),
  uniswapV4PoolProvenance: z.object({
    blockNumber: z.number().int().nonnegative(),
    poolId: CanonicalBytes32Schema,
    poolManagerAddress: CanonicalEvmAddressSchema,
    poolManagerCodeHash: CanonicalBytes32Schema,
    stateViewAddress: CanonicalEvmAddressSchema,
    stateViewCodeHash: CanonicalBytes32Schema,
    sqrtPriceX96: z.string().regex(/^[1-9][0-9]*$/),
    tick: z.number().int().min(-8_388_608).max(8_388_607),
    protocolFee: z.number().int().min(0).max(0xffffff),
    lpFee: z.number().int().min(0).max(0xffffff),
    liquidity: z.string().regex(/^[1-9][0-9]*$/),
  }).optional(),
});
export type DexMeasuredExecutionPublicProfile = z.infer<typeof DexMeasuredExecutionPublicProfileSchema>;

export function toDexMeasuredExecutionPublicProfile(
  input: DexMeasuredExecutionProfile,
  options: { observationHistory?: DexMeasuredExecutionObservationHistory } = {},
): DexMeasuredExecutionPublicProfile {
  const parsed = DexMeasuredExecutionProfileSchema.parse(input);
  const {
    quoteProof: _quoteProof,
    poolBindingProof,
    registryBindingProof,
    stableSwapNgFactoryBindingProof,
    curveCompositeProof,
    uniswapV4PoolProof,
    ...profile
  } = parsed;
  return DexMeasuredExecutionPublicProfileSchema.parse({
    ...profile,
    ...(options.observationHistory ? { observationHistory: options.observationHistory } : {}),
    ...(poolBindingProof
      ? {
          poolProvenance: {
            factoryAddress: poolBindingProof.factoryAddress,
            factoryCodeHash: poolBindingProof.factoryCodeHash,
            resolvedPoolAddress: poolBindingProof.resolvedPoolAddress,
          },
        }
      : {}),
    ...(registryBindingProof
      ? {
          registryProvenance: {
            registryAddress: registryBindingProof.registryAddress,
            registryCodeHash: registryBindingProof.registryCodeHash,
            registeredPoolAddress: registryBindingProof.registeredPoolAddress,
            lpTokenAddress: registryBindingProof.lpTokenAddress,
            poolTokenAddresses: registryBindingProof.poolTokenAddresses,
          },
        }
      : {}),
    ...(stableSwapNgFactoryBindingProof
      ? {
          stableSwapNgFactoryProvenance: {
            blockNumber: stableSwapNgFactoryBindingProof.blockNumber,
            blockHash: stableSwapNgFactoryBindingProof.blockHash,
            blockCommitment: stableSwapNgFactoryBindingProof.blockCommitment,
            factoryAddress: stableSwapNgFactoryBindingProof.factoryAddress,
            factoryCodeHash: stableSwapNgFactoryBindingProof.factoryCodeHash,
            poolIndex: stableSwapNgFactoryBindingProof.poolIndex,
            registeredPoolAddress: stableSwapNgFactoryBindingProof.registeredPoolAddress,
            poolTokenAddresses: stableSwapNgFactoryBindingProof.poolTokenAddresses,
          },
        }
      : {}),
    ...(curveCompositeProof
      ? {
          curveCompositeProvenance: {
            blockNumber: curveCompositeProof.blockNumber,
            blockHash: curveCompositeProof.blockHash,
            factoryAddress: curveCompositeProof.factoryAddress,
            factoryCodeHash: curveCompositeProof.factoryCodeHash,
            registeredPoolAddress: curveCompositeProof.registeredPoolAddress,
            implementationAddress: curveCompositeProof.implementationAddress,
            implementationCodeHash: curveCompositeProof.implementationCodeHash,
            quoteFunction: curveCompositeProof.quoteFunction,
            poolTokenAddresses: curveCompositeProof.poolTokenAddresses,
            executionTokenAddresses: curveCompositeProof.executionTokenAddresses,
            ...(curveCompositeProof.rateProvider
              ? { rateProviderAddress: curveCompositeProof.rateProvider.providerAddress }
              : {}),
            ...(curveCompositeProof.metapool
              ? { basePoolAddress: curveCompositeProof.metapool.basePoolAddress }
              : {}),
          },
        }
      : {}),
    ...(uniswapV4PoolProof
      ? {
          uniswapV4PoolProvenance: {
            blockNumber: uniswapV4PoolProof.blockNumber,
            poolId: uniswapV4PoolProof.poolId,
            poolManagerAddress: uniswapV4PoolProof.poolManagerAddress,
            poolManagerCodeHash: uniswapV4PoolProof.poolManagerCodeHash,
            stateViewAddress: uniswapV4PoolProof.stateViewAddress,
            stateViewCodeHash: uniswapV4PoolProof.stateViewCodeHash,
            sqrtPriceX96: uniswapV4PoolProof.sqrtPriceX96,
            tick: uniswapV4PoolProof.tick,
            protocolFee: uniswapV4PoolProof.protocolFee,
            lpFee: uniswapV4PoolProof.lpFee,
            liquidity: uniswapV4PoolProof.liquidity,
          },
        }
      : {}),
  });
}

export type DexMeasuredExecutionValidationReason =
  | "invalid-profile"
  | "target-generation-mismatch"
  | "quote-generation-mismatch"
  | "target-snapshot-mismatch"
  | "identity-mismatch"
  | "tracked-input-mismatch"
  | "stale-observation"
  | "future-observation"
  | "observation-before-target"
  | "retained-price-mismatch"
  | "retained-tvl-mismatch"
  | "token-reference-price-mismatch"
  | "quote-price-mismatch"
  | "capacity-above-retained-tvl-bound"
  | "invalid-capacity-curve"
  | "invalid-quote-proof";

function canonicalPart(value: string): string {
  return value.trim().toLowerCase();
}

export function buildDexMeasuredExecutionTargetId(input: {
  adapterProfileId: string;
  stablecoinId: string;
  chain: string;
  protocol: string;
  poolId: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  poolTokenAddresses?: readonly string[];
  feePips?: number;
  tickSpacing?: number;
  hookAddress?: string;
}): string {
  return [
    DEX_MEASURED_TARGET_SCHEMA_VERSION,
    input.adapterProfileId,
    input.stablecoinId,
    input.chain,
    input.protocol,
    input.poolId,
    input.tokenInAddress,
    input.tokenOutAddress,
    ...(input.poolTokenAddresses ?? []),
    input.feePips ?? "na",
    ...(input.tickSpacing != null ? [input.tickSpacing] : []),
    ...(input.hookAddress != null ? [input.hookAddress] : []),
  ]
    .map((part) => canonicalPart(String(part)))
    .join("|");
}

export function getDexMeasuredExecutionProbeNotionals(retainedTvlUsd: number): number[] {
  if (!Number.isFinite(retainedTvlUsd) || retainedTvlUsd <= 0) return [];
  if (retainedTvlUsd >= 2_500_000) {
    return [DEX_MEASURED_MARGINAL_NOTIONAL_USD, ...DEX_MEASURED_CAPACITY_NOTIONALS_USD];
  }
  if (retainedTvlUsd >= 250_000) {
    return [DEX_MEASURED_MARGINAL_NOTIONAL_USD, 100_000, 1_000_000];
  }
  return [DEX_MEASURED_MARGINAL_NOTIONAL_USD, 100_000];
}

function roundUsd(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function roundRatio(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000_000) / 1_000_000;
}

function relativeDifference(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return Infinity;
  return Math.abs(left / right - 1);
}

function rawAmountToUsd(rawAmount: string, decimals: number, referencePriceUsd: number): number | null {
  try {
    const amount = BigInt(rawAmount);
    if (amount < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null;
    const priceScale = 100_000_000n;
    const usdScale = 1_000_000n;
    const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
    if (priceScaled <= 0n) return null;
    const usdScaled = amount * priceScaled * usdScale / (10n ** BigInt(decimals) * priceScale);
    const usd = Number(usdScaled) / Number(usdScale);
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch {
    return null;
  }
}

/** Build fixed P4 points from quoted passing inputs only; never interpolates. */
export function buildDexMeasuredCapacityCurve(
  proof: readonly Pick<DexMeasuredExecutionQuotePointProof, "inputUsd" | "costBps" | "passesCostBound">[],
  retainedTvlUsd: number,
): z.infer<typeof ExitRouteCapacityPointSchema>[] {
  const tvlBound = retainedTvlUsd * 1.5;
  const passingQuotes = proof
    .filter((point) => point.passesCostBound && point.inputUsd <= tvlBound)
    .filter(
      (point) =>
        Number.isFinite(point.inputUsd) &&
        point.inputUsd > 0 &&
        Number.isFinite(point.costBps) &&
        point.costBps >= 0 &&
        point.costBps <= DEX_MEASURED_MAX_COST_BPS,
    )
    .sort((left, right) => left.inputUsd - right.inputUsd || right.costBps - left.costBps);

  return DEX_MEASURED_CAPACITY_NOTIONALS_USD.map((requestedNotionalUsd) => {
    const definingQuote = passingQuotes.reduce<(typeof passingQuotes)[number] | null>(
      (largest, quote) =>
        quote.inputUsd <= requestedNotionalUsd &&
        (largest === null ||
          quote.inputUsd > largest.inputUsd ||
          (quote.inputUsd === largest.inputUsd && quote.costBps > largest.costBps))
          ? quote
          : largest,
      null,
    );
    const executableUsd = roundUsd(definingQuote?.inputUsd ?? 0);
    return {
      requestedNotionalUsd,
      maxCostBps: DEX_MEASURED_MAX_COST_BPS,
      executableUsd,
      completionRatio: roundRatio(executableUsd / requestedNotionalUsd),
      ...(definingQuote ? { executionCostBps: definingQuote.costBps } : {}),
    };
  });
}

/**
 * New profiles attest realized capacity-point cost. Legacy profiles remain
 * valid when that additive field is absent; V9 then uses the request bound.
 */
function dexMeasuredCapacityPointMatchesProof(
  claimed: z.infer<typeof ExitRouteCapacityPointSchema> | undefined,
  rebuilt: z.infer<typeof ExitRouteCapacityPointSchema>,
): boolean {
  return (
    claimed != null &&
    claimed.requestedNotionalUsd === rebuilt.requestedNotionalUsd &&
    claimed.maxCostBps === rebuilt.maxCostBps &&
    Math.abs(claimed.executableUsd - rebuilt.executableUsd) <= 0.01 &&
    Math.abs(claimed.completionRatio - rebuilt.completionRatio) <= 0.000001 &&
    (claimed.executionCostBps == null ||
      (rebuilt.executionCostBps != null &&
        Math.abs(claimed.executionCostBps - rebuilt.executionCostBps) <= 0.02))
  );
}

/**
 * Independent consumer-side validation. Producer rows that fail any check stay
 * in the capability denominator but cannot emit measured observations.
 */
export function validateDexMeasuredExecutionProfile(input: {
  profile: unknown;
  quotedTarget: DexMeasuredExecutionTarget;
  currentTarget: DexMeasuredExecutionTarget;
  expectedTargetGenerationId: string;
  expectedQuoteGenerationId: string;
  nowSec: number;
}): DexMeasuredExecutionValidationReason[] {
  const parsed = DexMeasuredExecutionProfileSchema.safeParse(input.profile);
  if (!parsed.success) return ["invalid-profile"];
  const profile = parsed.data;
  const issues = new Set<DexMeasuredExecutionValidationReason>();
  const quotedTarget = input.quotedTarget;
  const currentTarget = input.currentTarget;

  if (
    canonicalPart(profile.chain) !== canonicalPart(currentTarget.chain) ||
    canonicalPart(profile.protocol) !== canonicalPart(currentTarget.protocol) ||
    canonicalPart(profile.poolId) !== canonicalPart(currentTarget.poolId) ||
    profile.targetId !== currentTarget.targetId ||
    currentTarget.targetId !== quotedTarget.targetId ||
    profile.adapterProfileId !== currentTarget.adapterProfileId
  ) issues.add("identity-mismatch");
  if (profile.targetGenerationId !== input.expectedTargetGenerationId) issues.add("target-generation-mismatch");
  if (profile.quoteGenerationId !== input.expectedQuoteGenerationId) issues.add("quote-generation-mismatch");
  if (profile.tokenIn.trackedAssetId !== currentTarget.stablecoinId) issues.add("tracked-input-mismatch");
  if (profile.quotedAt > input.nowSec + 60) issues.add("future-observation");
  if (profile.quotedAt < quotedTarget.capturedAt) issues.add("observation-before-target");
  if (
    input.nowSec - profile.quotedAt >
    getDexMeasuredExecutionFreshnessMaxSec(profile.adapterProfileId)
  ) issues.add("stale-observation");

  const retainedPrice = currentTarget.retainedPoolPriceUsd;
  if (
    !Number.isFinite(retainedPrice) ||
    retainedPrice <= 0 ||
    Math.abs(profile.retainedPoolPriceUsdAtQuote / retainedPrice - 1) > 0.02
  ) issues.add("retained-price-mismatch");
  if (relativeDifference(profile.retainedTvlUsdAtQuote, currentTarget.retainedTvlUsd) > 0.2) {
    issues.add("retained-tvl-mismatch");
  }
  if (
    relativeDifference(profile.tokenIn.referencePriceUsd, currentTarget.tokenIn.referencePriceUsd) > 0.02 ||
    relativeDifference(profile.tokenOut.referencePriceUsd, currentTarget.tokenOut.referencePriceUsd) > 0.02
  ) issues.add("token-reference-price-mismatch");
  const exactSnapshotMatches =
    profile.targetId === quotedTarget.targetId &&
    profile.adapterProfileId === quotedTarget.adapterProfileId &&
    canonicalPart(profile.chain) === canonicalPart(quotedTarget.chain) &&
    canonicalPart(profile.protocol) === canonicalPart(quotedTarget.protocol) &&
    canonicalPart(profile.poolId) === canonicalPart(quotedTarget.poolId) &&
    JSON.stringify(profile.poolTokenAddresses ?? null) === JSON.stringify(quotedTarget.poolTokenAddresses ?? null) &&
    canonicalPart(profile.tokenIn.address) === canonicalPart(quotedTarget.tokenIn.address) &&
    canonicalPart(profile.tokenOut.address) === canonicalPart(quotedTarget.tokenOut.address) &&
    profile.tokenIn.symbol === quotedTarget.tokenIn.symbol &&
    profile.tokenOut.symbol === quotedTarget.tokenOut.symbol &&
    profile.tokenIn.decimals === quotedTarget.tokenIn.decimals &&
    profile.tokenOut.decimals === quotedTarget.tokenOut.decimals &&
    profile.tokenIn.trackedAssetId === quotedTarget.tokenIn.trackedAssetId &&
    profile.tokenOut.trackedAssetId === quotedTarget.tokenOut.trackedAssetId &&
    profile.feePips === quotedTarget.feePips &&
    profile.tickSpacing === quotedTarget.tickSpacing &&
    profile.hookAddress === quotedTarget.hookAddress &&
    Math.abs(profile.retainedTvlUsdAtQuote - quotedTarget.retainedTvlUsd) <= 0.01 &&
    Math.abs(profile.retainedPoolPriceUsdAtQuote - quotedTarget.retainedPoolPriceUsd) <= 0.00000001 &&
    Math.abs(profile.tokenIn.referencePriceUsd - quotedTarget.tokenIn.referencePriceUsd) <= 0.00000001 &&
    Math.abs(profile.tokenOut.referencePriceUsd - quotedTarget.tokenOut.referencePriceUsd) <= 0.00000001;
  if (!exactSnapshotMatches) issues.add("target-snapshot-mismatch");

  const currentIdentityMatches =
    canonicalPart(profile.tokenIn.address) === canonicalPart(currentTarget.tokenIn.address) &&
    canonicalPart(profile.tokenOut.address) === canonicalPart(currentTarget.tokenOut.address) &&
    profile.tokenIn.symbol === currentTarget.tokenIn.symbol &&
    profile.tokenOut.symbol === currentTarget.tokenOut.symbol &&
    profile.tokenIn.decimals === currentTarget.tokenIn.decimals &&
    profile.tokenOut.decimals === currentTarget.tokenOut.decimals &&
    profile.tokenIn.trackedAssetId === currentTarget.tokenIn.trackedAssetId &&
    profile.tokenOut.trackedAssetId === currentTarget.tokenOut.trackedAssetId &&
    profile.feePips === currentTarget.feePips &&
    profile.tickSpacing === currentTarget.tickSpacing &&
    profile.hookAddress === currentTarget.hookAddress;
  const currentPoolOrderMatches =
    JSON.stringify(profile.poolTokenAddresses ?? null) === JSON.stringify(currentTarget.poolTokenAddresses ?? null);
  if (!currentIdentityMatches || !currentPoolOrderMatches) issues.add("identity-mismatch");

  const recomputedProof = profile.quoteProof.map((point) => {
    const inputUsd = rawAmountToUsd(point.amountInRaw, profile.tokenIn.decimals, profile.tokenIn.referencePriceUsd);
    const outputUsd = rawAmountToUsd(point.amountOutRaw, profile.tokenOut.decimals, profile.tokenOut.referencePriceUsd);
    if (inputUsd == null || outputUsd == null || inputUsd <= 0) return null;
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return {
      inputUsd,
      outputUsd,
      costBps,
      passesCostBound: costBps <= profile.maxCostBps,
    };
  });
  if (
    recomputedProof.some((point) => point == null) ||
    recomputedProof.some((point, index) => {
      if (point == null) return true;
      const claimed = profile.quoteProof[index]!;
      return Math.abs(point.inputUsd - claimed.inputUsd) > 0.02 ||
        Math.abs(point.outputUsd - claimed.outputUsd) > 0.02 ||
        Math.abs(point.costBps - claimed.costBps) > 0.02 ||
        point.passesCostBound !== claimed.passesCostBound ||
        (claimed.reverted === true
          ? claimed.amountOutRaw !== "0" ||
            claimed.outputUsd !== 0 ||
            Math.abs(claimed.costBps - 10_000) > 0.02 ||
            claimed.passesCostBound
          : claimed.returnData === "0x");
    })
  ) issues.add("invalid-quote-proof");
  const recomputedMarginal = recomputedProof[0];
  if (
    recomputedMarginal == null ||
    Math.abs(profile.marginalOutputRatio - recomputedMarginal.outputUsd / recomputedMarginal.inputUsd) > 0.000001
  ) issues.add("invalid-quote-proof");
  // A marginal quote below the cost bound is valid measured zero-capacity
  // evidence. Only an implausibly favorable quote breaches the spot guard.
  if (
    recomputedMarginal == null ||
    recomputedMarginal.outputUsd / recomputedMarginal.inputUsd > DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO
  ) {
    issues.add("quote-price-mismatch");
  }

  const rebuiltCurve = buildDexMeasuredCapacityCurve(
    recomputedProof.filter((point): point is NonNullable<typeof point> => point != null),
    profile.retainedTvlUsdAtQuote,
  );
  const curveMatches = rebuiltCurve.every((rebuilt, index) =>
    dexMeasuredCapacityPointMatchesProof(profile.capacityCurve[index], rebuilt),
  );
  if (!curveMatches) issues.add("invalid-capacity-curve");

  const sortedProof = [...profile.quoteProof].sort((left, right) => left.inputUsd - right.inputUsd);
  const probeNotionals = getDexMeasuredExecutionProbeNotionals(profile.retainedTvlUsdAtQuote);
  let firstFailedProbeIndex = -1;
  for (let index = 0; index < probeNotionals.length; index += 1) {
    const notional = probeNotionals[index]!;
    const exactPoint = sortedProof.find((point) => Math.abs(point.inputUsd - notional) <= 0.02);
    if (firstFailedProbeIndex === -1) {
      if (!exactPoint) {
        issues.add("invalid-quote-proof");
        break;
      }
      if (!exactPoint.passesCostBound) firstFailedProbeIndex = index;
    } else if (exactPoint) {
      issues.add("invalid-quote-proof");
      break;
    }
  }
  if (
    Math.abs((sortedProof[0]?.inputUsd ?? 0) - DEX_MEASURED_MARGINAL_NOTIONAL_USD) > 0.02 ||
    sortedProof.some((point, index) => index > 0 && point.inputUsd <= sortedProof[index - 1]!.inputUsd) ||
    sortedProof.some((point) => point.passesCostBound !== (point.costBps <= profile.maxCostBps + 0.000001))
  ) issues.add("invalid-quote-proof");

  const probeCeiling = probeNotionals[probeNotionals.length - 1] ?? 0;
  const retainedTvlBound = profile.retainedTvlUsdAtQuote * 1.5;
  for (const capacityPoint of profile.capacityCurve) {
    if (capacityPoint.executableUsd > 0 && !sortedProof.some(
      (point) => point.passesCostBound && Math.abs(point.inputUsd - capacityPoint.executableUsd) <= 0.02,
    )) issues.add("invalid-quote-proof");
    if (capacityPoint.requestedNotionalUsd <= probeCeiling && capacityPoint.executableUsd < capacityPoint.requestedNotionalUsd) {
      const hasFailingUpperBracket = sortedProof.some((point) =>
        !point.passesCostBound &&
        point.inputUsd > capacityPoint.executableUsd &&
        point.inputUsd <= capacityPoint.requestedNotionalUsd + 0.02
      );
      const hasPassingProbeAbovePolicyCap = sortedProof.some((point) =>
        point.passesCostBound &&
        point.inputUsd > retainedTvlBound + 0.01 &&
        point.inputUsd <= capacityPoint.requestedNotionalUsd + 0.02
      );
      if (!hasFailingUpperBracket && !hasPassingProbeAbovePolicyCap) issues.add("invalid-quote-proof");
    }
  }

  if (profile.capacityCurve.some((point) => point.executableUsd > currentTarget.retainedTvlUsd * 1.5 + 0.01)) {
    issues.add("capacity-above-retained-tvl-bound");
  }

  const expectedTargetId = buildDexMeasuredExecutionTargetId({
    adapterProfileId: profile.adapterProfileId,
    stablecoinId: currentTarget.stablecoinId,
    chain: currentTarget.chain,
    protocol: currentTarget.protocol,
    poolId: currentTarget.poolId,
    tokenInAddress: profile.tokenIn.address,
    tokenOutAddress: profile.tokenOut.address,
    ...(profile.poolTokenAddresses ? { poolTokenAddresses: profile.poolTokenAddresses } : {}),
    ...(profile.feePips != null ? { feePips: profile.feePips } : {}),
    ...(profile.tickSpacing != null ? { tickSpacing: profile.tickSpacing } : {}),
    ...(profile.hookAddress != null ? { hookAddress: profile.hookAddress } : {}),
  });
  if (profile.targetId !== expectedTargetId) {
    issues.add("identity-mismatch");
  }

  return [...issues];
}
