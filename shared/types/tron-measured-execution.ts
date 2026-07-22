import { z } from "zod";

import { ExitRouteCapacityPointSchema } from "./exit-route";
import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_MARGINAL_NOTIONAL_USD,
  DEX_MEASURED_MAX_COST_BPS,
  DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO,
  buildDexMeasuredCapacityCurve,
  getDexMeasuredExecutionProbeNotionals,
} from "./measured-execution";

export const TRON_MEASURED_TARGET_SCHEMA_VERSION = "tron-measured-target-v1" as const;
export const TRON_MEASURED_EXECUTION_SCHEMA_VERSION = "tron-measured-execution-v1" as const;
export const TRON_MEASURED_MAX_BLOCK_WINDOW = 64;

const TronAddressSchema = z.string().regex(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
const CodeHashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
const PositiveIntegerStringSchema = z.string().regex(/^[1-9][0-9]*$/);

export const TronMeasuredExecutionTokenSchema = z.object({
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
  tokenIn: TronMeasuredExecutionTokenSchema,
  tokenOut: TronMeasuredExecutionTokenSchema,
  feeRate: z.literal(0.003),
  retainedTvlUsd: z.number().finite().positive(),
  retainedPoolPriceUsd: z.number().finite().positive(),
  capturedAt: z.number().int().nonnegative(),
});
export type TronMeasuredExecutionTarget = z.infer<typeof TronMeasuredExecutionTargetSchema>;

export const TronMeasuredRouteProofSchema = z.object({
  provider: z.literal("sun-smart-router"),
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
export type TronMeasuredRouteProof = z.infer<typeof TronMeasuredRouteProofSchema>;

export const TronMeasuredExecutionQuotePointProofSchema = z.object({
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

function relativeDifference(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return Infinity;
  return Math.abs(left / right - 1);
}

function rawAmountToUsd(rawAmount: string, decimals: number, referencePriceUsd: number): number | null {
  try {
    const amount = BigInt(rawAmount);
    const priceScale = 100_000_000n;
    const usdScale = 1_000_000n;
    const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
    if (amount <= 0n || priceScaled <= 0n) return null;
    const usdScaled = amount * priceScaled * usdScale / (10n ** BigInt(decimals) * priceScale);
    const usd = Number(usdScaled) / Number(usdScale);
    return Number.isFinite(usd) && usd > 0 ? usd : null;
  } catch {
    return null;
  }
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
  const quotedTarget = input.quotedTarget;
  const currentTarget = input.currentTarget;
  const issues = new Set<TronMeasuredExecutionValidationReason>();

  if (profile.targetGenerationId !== input.expectedTargetGenerationId) issues.add("target-generation-mismatch");
  if (profile.quoteGenerationId !== input.expectedQuoteGenerationId) issues.add("quote-generation-mismatch");
  if (profile.tokenIn.trackedAssetId !== currentTarget.stablecoinId) issues.add("tracked-input-mismatch");
  if (profile.quotedAt > input.nowSec + 60) issues.add("future-observation");
  if (profile.quotedAt < quotedTarget.capturedAt) issues.add("observation-before-target");
  if (input.nowSec - profile.quotedAt > DEX_MEASURED_FRESHNESS_MAX_SEC) issues.add("stale-observation");

  const snapshotMatches =
    profile.targetId === quotedTarget.targetId &&
    profile.adapterProfileId === quotedTarget.adapterProfileId &&
    profile.protocol === quotedTarget.protocol &&
    profile.poolId === quotedTarget.poolId &&
    profile.poolType === quotedTarget.poolType &&
    JSON.stringify(profile.tokenIn) === JSON.stringify(quotedTarget.tokenIn) &&
    JSON.stringify(profile.tokenOut) === JSON.stringify(quotedTarget.tokenOut) &&
    Math.abs(profile.retainedTvlUsdAtQuote - quotedTarget.retainedTvlUsd) <= 0.01 &&
    Math.abs(profile.retainedPoolPriceUsdAtQuote - quotedTarget.retainedPoolPriceUsd) <= 0.00000001;
  if (!snapshotMatches) issues.add("target-snapshot-mismatch");

  const identityMatches =
    profile.targetId === currentTarget.targetId &&
    profile.poolId === currentTarget.poolId &&
    profile.tokenIn.address === currentTarget.tokenIn.address &&
    profile.tokenOut.address === currentTarget.tokenOut.address &&
    profile.tokenIn.decimals === currentTarget.tokenIn.decimals &&
    profile.tokenOut.decimals === currentTarget.tokenOut.decimals;
  if (!identityMatches) issues.add("identity-mismatch");
  if (relativeDifference(profile.retainedTvlUsdAtQuote, currentTarget.retainedTvlUsd) > 0.2) {
    issues.add("retained-tvl-mismatch");
  }
  if (relativeDifference(profile.retainedPoolPriceUsdAtQuote, currentTarget.retainedPoolPriceUsd) > 0.02) {
    issues.add("retained-price-mismatch");
  }
  if (
    relativeDifference(profile.tokenIn.referencePriceUsd, currentTarget.tokenIn.referencePriceUsd) > 0.02 ||
    relativeDifference(profile.tokenOut.referencePriceUsd, currentTarget.tokenOut.referencePriceUsd) > 0.02
  ) issues.add("token-reference-price-mismatch");

  const recomputedProof = profile.quoteProof.map((point) => {
    const inputUsd = rawAmountToUsd(point.amountInRaw, profile.tokenIn.decimals, profile.tokenIn.referencePriceUsd);
    const outputUsd = rawAmountToUsd(point.amountOutRaw, profile.tokenOut.decimals, profile.tokenOut.referencePriceUsd);
    if (inputUsd == null || outputUsd == null) return null;
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return { inputUsd, outputUsd, costBps, passesCostBound: costBps <= profile.maxCostBps };
  });

  profile.quoteProof.forEach((point, index) => {
    const route = point.route;
    const recomputed = recomputedProof[index];
    const inputIsToken0 = route.inputToken === route.token0 && route.outputToken === route.token1;
    const inputIsToken1 = route.inputToken === route.token1 && route.outputToken === route.token0;
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
      recomputed == null ||
      point.amountInRaw !== route.inputAmountRaw ||
      point.amountOutRaw !== route.outputAmountRaw ||
      route.outputAmountRaw !== route.expectedOutputAmountRaw ||
      expectedOutput?.toString() !== route.outputAmountRaw ||
      route.poolId !== profile.poolId ||
      route.factoryAddress !== currentTarget.factoryAddress ||
      route.factoryCodeHash !== currentTarget.expectedFactoryCodeHash ||
      route.pairCodeHash !== currentTarget.expectedPairCodeHash ||
      route.inputToken !== profile.tokenIn.address ||
      route.outputToken !== profile.tokenOut.address ||
      route.routeTokens[0] !== profile.tokenIn.address ||
      route.routeTokens[1] !== profile.tokenOut.address ||
      Math.abs(recomputed.inputUsd - point.inputUsd) > 0.02 ||
      Math.abs(recomputed.outputUsd - point.outputUsd) > 0.02 ||
      Math.abs(recomputed.costBps - point.costBps) > 0.02 ||
      recomputed.passesCostBound !== point.passesCostBound
    ) issues.add("invalid-quote-proof");
    if (
      route.blockAfter < route.blockBefore ||
      route.blockAfter - route.blockBefore > TRON_MEASURED_MAX_BLOCK_WINDOW
    ) issues.add("invalid-block-proof");
  });

  const marginal = recomputedProof[0];
  if (
    marginal == null ||
    Math.abs(profile.marginalOutputRatio - marginal.outputUsd / marginal.inputUsd) > 0.000001
  ) issues.add("invalid-quote-proof");
  if (marginal == null || marginal.outputUsd / marginal.inputUsd > DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO) {
    issues.add("quote-price-mismatch");
  }

  const rebuiltCurve = buildDexMeasuredCapacityCurve(
    recomputedProof.filter((point): point is NonNullable<typeof point> => point != null),
    profile.retainedTvlUsdAtQuote,
  );
  if (rebuiltCurve.some((point, index) => JSON.stringify(point) !== JSON.stringify(profile.capacityCurve[index]))) {
    issues.add("invalid-capacity-curve");
  }

  const sorted = [...profile.quoteProof].sort((left, right) => left.inputUsd - right.inputUsd);
  const probeNotionals = getDexMeasuredExecutionProbeNotionals(profile.retainedTvlUsdAtQuote);
  let stopped = false;
  for (const notional of probeNotionals) {
    const point = sorted.find((candidate) => Math.abs(candidate.inputUsd - notional) <= 0.02);
    if (stopped ? point != null : point == null) {
      issues.add("invalid-quote-proof");
      break;
    }
    if (point && !point.passesCostBound) stopped = true;
  }
  if (
    Math.abs((sorted[0]?.inputUsd ?? 0) - DEX_MEASURED_MARGINAL_NOTIONAL_USD) > 0.02 ||
    sorted.some((point, index) => index > 0 && point.inputUsd <= sorted[index - 1]!.inputUsd)
  ) issues.add("invalid-quote-proof");

  const expectedTargetId = buildTronMeasuredExecutionTargetId({
    stablecoinId: profile.tokenIn.trackedAssetId ?? "",
    poolId: profile.poolId,
    tokenInAddress: profile.tokenIn.address,
    tokenOutAddress: profile.tokenOut.address,
  });
  if (profile.targetId !== expectedTargetId) issues.add("identity-mismatch");

  return [...issues];
}
