import { z } from "zod";

import { ExitRouteCapacityPointSchema } from "./exit-route";
import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_MAX_COST_BPS,
} from "./measured-execution";
import { validateNativeMeasuredExecutionProfile } from "./native-measured-execution";

export const TRON_MEASURED_TARGET_SCHEMA_VERSION = "tron-measured-target-v1" as const;
export const TRON_MEASURED_EXECUTION_SCHEMA_VERSION = "tron-measured-execution-v1" as const;
export const TRON_MEASURED_MAX_BLOCK_WINDOW = 64;
const TRON_SUNSWAP_V2_ROUTER_ADDRESS = "TNJVzGqKBWkJxJB5XYSqGAwUTV15U24pPq" as const;
const TRON_SUNSWAP_V2_ROUTER_CODE_HASH =
  "0x85aca0ac3551e3d4fdebd328f247b2287254c06b583040582cc2d4cd0d969d67" as const;

const TronAddressSchema = z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
const CodeHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const PositiveIntegerStringSchema = z.string().regex(/^[1-9][0-9]*$/);

const TronMeasuredExecutionTokenSchema = z.object({
  address: TronAddressSchema,
  symbol: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(255),
  referencePriceUsd: z.number().finite().positive(),
  referencePriceSource: z.enum(["tracked", "source-token-usd", "pool-implied"]),
  trackedAssetId: z.string().min(1).optional(),
});
export type TronMeasuredExecutionToken = z.infer<typeof TronMeasuredExecutionTokenSchema>;

export const TronMeasuredExecutionTargetSchema = z.object({
  schemaVersion: z.literal(TRON_MEASURED_TARGET_SCHEMA_VERSION),
  targetId: z.string().min(1).max(512),
  stablecoinId: z.string().min(1),
  adapterProfileId: z.literal("sunswap-v2-router-v1"),
  protocol: z.literal("sunswap"),
  chain: z.literal("tron"),
  poolId: TronAddressSchema,
  poolType: z.literal("sunswap-v2"),
  factoryAddress: TronAddressSchema,
  expectedFactoryCodeHash: CodeHashSchema,
  expectedPairCodeHash: CodeHashSchema,
  routerAddress: TronAddressSchema.default(TRON_SUNSWAP_V2_ROUTER_ADDRESS),
  expectedRouterCodeHash: CodeHashSchema.default(TRON_SUNSWAP_V2_ROUTER_CODE_HASH),
  tokenIn: TronMeasuredExecutionTokenSchema,
  tokenOut: TronMeasuredExecutionTokenSchema,
  feeRate: z.literal(0.003),
  retainedTvlUsd: z.number().finite().positive(),
  retainedPoolPriceUsd: z.number().finite().positive(),
  capturedAt: z.number().int().nonnegative(),
});
export type TronMeasuredExecutionTarget = z.infer<typeof TronMeasuredExecutionTargetSchema>;

const TronMeasuredRouteProofBaseSchema = z.object({
  poolId: TronAddressSchema,
  factoryAddress: TronAddressSchema,
  factoryCodeHash: CodeHashSchema,
  pairCodeHash: CodeHashSchema,
  token0: TronAddressSchema,
  token1: TronAddressSchema,
  reserve0Raw: PositiveIntegerStringSchema,
  reserve1Raw: PositiveIntegerStringSchema,
  inputToken: TronAddressSchema,
  outputToken: TronAddressSchema,
  inputAmountRaw: PositiveIntegerStringSchema,
  outputAmountRaw: PositiveIntegerStringSchema,
  expectedOutputAmountRaw: PositiveIntegerStringSchema,
  routeTokens: z.tuple([TronAddressSchema, TronAddressSchema]),
  poolVersions: z.tuple([z.literal("v2")]),
  blockBefore: z.number().int().nonnegative(),
  blockAfter: z.number().int().nonnegative(),
});

const TronMeasuredRouteProofSchema = z.discriminatedUnion("provider", [
  TronMeasuredRouteProofBaseSchema.extend({
    provider: z.literal("sun-smart-router"),
  }),
  TronMeasuredRouteProofBaseSchema.extend({
    provider: z.literal("sunswap-v2-router"),
    routerAddress: TronAddressSchema,
    routerCodeHash: CodeHashSchema,
    routerFactoryAddress: TronAddressSchema,
  }),
]);
export type TronMeasuredRouteProof = z.infer<typeof TronMeasuredRouteProofSchema>;

const TronMeasuredExecutionQuotePointProofSchema = z.object({
  amountInRaw: PositiveIntegerStringSchema,
  amountOutRaw: PositiveIntegerStringSchema,
  inputUsd: z.number().finite().positive(),
  outputUsd: z.number().finite().positive(),
  costBps: z.number().finite().nonnegative(),
  passesCostBound: z.boolean(),
  route: TronMeasuredRouteProofSchema,
});
export type TronMeasuredExecutionQuotePointProof = z.infer<
  typeof TronMeasuredExecutionQuotePointProofSchema
>;

export const TronMeasuredExecutionProfileSchema = z.object({
  schemaVersion: z.literal(TRON_MEASURED_EXECUTION_SCHEMA_VERSION),
  kind: z.literal("measured-executable-depth"),
  targetId: z.string().min(1).max(512),
  targetGenerationId: z.string().min(1).max(128),
  quoteGenerationId: z.string().min(1).max(128),
  adapterProfileId: TronMeasuredExecutionTargetSchema.shape.adapterProfileId,
  protocol: TronMeasuredExecutionTargetSchema.shape.protocol,
  chain: z.literal("tron"),
  poolId: TronAddressSchema,
  poolType: TronMeasuredExecutionTargetSchema.shape.poolType,
  tokenIn: TronMeasuredExecutionTokenSchema,
  tokenOut: TronMeasuredExecutionTokenSchema,
  retainedTvlUsdAtQuote: z.number().finite().positive(),
  retainedPoolPriceUsdAtQuote: z.number().finite().positive(),
  quotedAt: z.number().int().nonnegative(),
  maxCostBps: z.literal(DEX_MEASURED_MAX_COST_BPS),
  marginalOutputRatio: z.number().finite().nonnegative(),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).length(DEX_MEASURED_CAPACITY_NOTIONALS_USD.length),
  quoteProof: z.array(TronMeasuredExecutionQuotePointProofSchema).min(1).max(8),
});
export type TronMeasuredExecutionProfile = z.infer<typeof TronMeasuredExecutionProfileSchema>;

export const TronMeasuredExecutionPublicProfileSchema = TronMeasuredExecutionProfileSchema.omit({
  quoteProof: true,
});
export type TronMeasuredExecutionPublicProfile = z.infer<
  typeof TronMeasuredExecutionPublicProfileSchema
>;

export function toTronMeasuredExecutionPublicProfile(
  input: TronMeasuredExecutionProfile,
): TronMeasuredExecutionPublicProfile {
  const parsed = TronMeasuredExecutionProfileSchema.parse(input);
  const { quoteProof: _quoteProof, ...profile } = parsed;
  return TronMeasuredExecutionPublicProfileSchema.parse(profile);
}

export function buildTronMeasuredExecutionTargetId(input: {
  stablecoinId: string;
  poolId: string;
  tokenInAddress: string;
  tokenOutAddress: string;
}): string {
  return [
    TRON_MEASURED_TARGET_SCHEMA_VERSION,
    "sunswap-v2-router-v1",
    input.stablecoinId.trim().toLowerCase(),
    "tron",
    "sunswap",
    input.poolId.trim(),
    input.tokenInAddress.trim(),
    input.tokenOutAddress.trim(),
  ].join("|");
}

export function quoteSunSwapV2ConstantProduct(input: {
  amountIn: bigint;
  reserveIn: bigint;
  reserveOut: bigint;
}): bigint | null {
  if (input.amountIn <= 0n || input.reserveIn <= 0n || input.reserveOut <= 0n) return null;
  const amountInWithFee = input.amountIn * 997n;
  const output = amountInWithFee * input.reserveOut / (input.reserveIn * 1_000n + amountInWithFee);
  return output > 0n && output < input.reserveOut ? output : null;
}

export type TronMeasuredExecutionValidationReason =
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
  | "invalid-capacity-curve"
  | "invalid-quote-proof"
  | "invalid-block-proof";

export function validateTronMeasuredExecutionProfile(input: {
  profile: unknown;
  quotedTarget: TronMeasuredExecutionTarget;
  currentTarget: TronMeasuredExecutionTarget;
  expectedTargetGenerationId: string;
  expectedQuoteGenerationId: string;
  nowSec: number;
}): TronMeasuredExecutionValidationReason[] {
  const parsed = TronMeasuredExecutionProfileSchema.safeParse(input.profile);
  if (!parsed.success) return ["invalid-profile"];
  const profile = parsed.data;
  return validateNativeMeasuredExecutionProfile<
    TronMeasuredExecutionTarget,
    TronMeasuredExecutionQuotePointProof,
    TronMeasuredExecutionProfile,
    TronMeasuredExecutionValidationReason
  >({
    ...input,
    profile,
    adapter: {
      currentIdentityMatches(candidate, currentTarget) {
        return (
          candidate.targetId === currentTarget.targetId &&
          candidate.poolId === currentTarget.poolId &&
          candidate.tokenIn.address === currentTarget.tokenIn.address &&
          candidate.tokenOut.address === currentTarget.tokenOut.address &&
          candidate.tokenIn.decimals === currentTarget.tokenIn.decimals &&
          candidate.tokenOut.decimals === currentTarget.tokenOut.decimals
        );
      },
      validateQuoteProof({ profile: candidate, currentTarget, point, recomputed }, issues) {
        const route = point.route;
        const inputIsToken0 = route.inputToken === route.token0 && route.outputToken === route.token1;
        const inputIsToken1 = route.inputToken === route.token1 && route.outputToken === route.token0;
        const routerIdentityMatches =
          route.provider === "sun-smart-router" ||
          (
            route.routerAddress === currentTarget.routerAddress &&
            route.routerCodeHash === currentTarget.expectedRouterCodeHash &&
            route.routerFactoryAddress === currentTarget.factoryAddress
          );
        const reserveIn = inputIsToken0 ? route.reserve0Raw : route.reserve1Raw;
        const reserveOut = inputIsToken0 ? route.reserve1Raw : route.reserve0Raw;
        let expectedOutput: bigint | null = null;
        try {
          if (inputIsToken0 || inputIsToken1) {
            expectedOutput = quoteSunSwapV2ConstantProduct({
              amountIn: BigInt(route.inputAmountRaw),
              reserveIn: BigInt(reserveIn),
              reserveOut: BigInt(reserveOut),
            });
          }
        } catch {
          expectedOutput = null;
        }
        if (
          point.amountInRaw !== route.inputAmountRaw ||
          point.amountOutRaw !== route.outputAmountRaw ||
          route.outputAmountRaw !== route.expectedOutputAmountRaw ||
          expectedOutput?.toString() !== route.outputAmountRaw ||
          route.poolId !== candidate.poolId ||
          route.factoryAddress !== currentTarget.factoryAddress ||
          route.factoryCodeHash !== currentTarget.expectedFactoryCodeHash ||
          route.pairCodeHash !== currentTarget.expectedPairCodeHash ||
          !routerIdentityMatches ||
          route.inputToken !== candidate.tokenIn.address ||
          route.outputToken !== candidate.tokenOut.address ||
          route.routeTokens[0] !== candidate.tokenIn.address ||
          route.routeTokens[1] !== candidate.tokenOut.address ||
          recomputed == null
        ) {
          issues.add("invalid-quote-proof");
        }
        if (
          route.blockAfter < route.blockBefore ||
          route.blockAfter - route.blockBefore > TRON_MEASURED_MAX_BLOCK_WINDOW
        ) {
          issues.add("invalid-block-proof");
        }
      },
      buildTargetId(candidate) {
        return buildTronMeasuredExecutionTargetId({
          stablecoinId: candidate.tokenIn.trackedAssetId ?? "",
          poolId: candidate.poolId,
          tokenInAddress: candidate.tokenIn.address,
          tokenOutAddress: candidate.tokenOut.address,
        });
      },
    },
  });
}
