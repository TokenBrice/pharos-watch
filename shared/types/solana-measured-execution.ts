import { z } from "zod";

import {
  DEX_MEASURED_CAPACITY_NOTIONALS_USD,
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_MARGINAL_NOTIONAL_USD,
  DEX_MEASURED_MAX_COST_BPS,
  DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO,
  buildDexMeasuredCapacityCurve,
  getDexMeasuredExecutionProbeNotionals,
} from "./measured-execution";
import { ExitRouteCapacityPointSchema } from "./exit-route";

export const SOLANA_MEASURED_TARGET_SCHEMA_VERSION = "solana-measured-target-v1" as const;
export const SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION = "solana-measured-execution-v1" as const;
export const SOLANA_MEASURED_MAX_SLOT_WINDOW = 512;
export const SOLANA_MEASURED_MAX_CONTEXT_SLOT_LAG = 2_250;
const SOLANA_MEASURED_MAX_CONTEXT_SLOT_LEAD = 250;

const SolanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

const SolanaMeasuredExecutionTokenSchema = z.object({
  address: SolanaAddressSchema,
  symbol: z.string().min(1).max(64),
  decimals: z.number().int().min(0).max(255),
  referencePriceUsd: z.number().finite().positive(),
  referencePriceSource: z.enum(["tracked", "pool-implied"]),
  trackedAssetId: z.string().min(1).optional(),
});
export type SolanaMeasuredExecutionToken = z.infer<typeof SolanaMeasuredExecutionTokenSchema>;

export const SolanaMeasuredExecutionTargetSchema = z.object({
  schemaVersion: z.literal(SOLANA_MEASURED_TARGET_SCHEMA_VERSION),
  targetId: z.string().min(1).max(512),
  stablecoinId: z.string().min(1),
  adapterProfileId: z.enum(["raydium-clmm-trade-api-v1", "orca-whirlpool-jupiter-v1"]),
  protocol: z.enum(["raydium", "orca"]),
  chain: z.literal("solana"),
  poolId: SolanaAddressSchema,
  poolType: z.enum(["raydium-clmm", "orca-whirlpool"]),
  tokenIn: SolanaMeasuredExecutionTokenSchema,
  tokenOut: SolanaMeasuredExecutionTokenSchema,
  retainedTvlUsd: z.number().finite().positive(),
  retainedPoolPriceUsd: z.number().finite().positive(),
  capturedAt: z.number().int().nonnegative(),
});
export type SolanaMeasuredExecutionTarget = z.infer<typeof SolanaMeasuredExecutionTargetSchema>;

const CommonRouteProofSchema = z.object({
  poolId: SolanaAddressSchema,
  inputMint: SolanaAddressSchema,
  outputMint: SolanaAddressSchema,
  inputAmount: z.string().regex(/^[1-9][0-9]*$/),
  outputAmount: z.string().regex(/^[0-9]+$/),
});

const SolanaMeasuredRaydiumRouteProofSchema = CommonRouteProofSchema.extend({
  provider: z.literal("raydium-trade-api"),
  responseId: z.string().min(1).max(128),
  lastPoolPriceX64: z.string().regex(/^[1-9][0-9]*$/),
});

const SolanaMeasuredOrcaRouteProofSchema = CommonRouteProofSchema.extend({
  provider: z.literal("jupiter-swap-api"),
  // Preserve historical proofs while accepting Jupiter's current label for
  // the same Orca Whirlpool program.
  label: z.enum(["Orca V2", "Whirlpool"]),
  contextSlot: z.number().int().nonnegative(),
});

const SolanaMeasuredRouteProofSchema = z.discriminatedUnion("provider", [
  SolanaMeasuredRaydiumRouteProofSchema,
  SolanaMeasuredOrcaRouteProofSchema,
]);
export type SolanaMeasuredRouteProof = z.infer<typeof SolanaMeasuredRouteProofSchema>;

const SolanaMeasuredExecutionQuotePointProofSchema = z.object({
  amountInRaw: z.string().regex(/^[1-9][0-9]*$/),
  amountOutRaw: z.string().regex(/^[0-9]+$/),
  inputUsd: z.number().finite().positive(),
  outputUsd: z.number().finite().nonnegative(),
  costBps: z.number().finite().nonnegative(),
  passesCostBound: z.boolean(),
  route: SolanaMeasuredRouteProofSchema,
});
export type SolanaMeasuredExecutionQuotePointProof = z.infer<typeof SolanaMeasuredExecutionQuotePointProofSchema>;

export const SolanaMeasuredExecutionProfileSchema = z.object({
  schemaVersion: z.literal(SOLANA_MEASURED_EXECUTION_SCHEMA_VERSION),
  kind: z.literal("measured-executable-depth"),
  targetId: z.string().min(1).max(512),
  targetGenerationId: z.string().min(1).max(128),
  quoteGenerationId: z.string().min(1).max(128),
  adapterProfileId: SolanaMeasuredExecutionTargetSchema.shape.adapterProfileId,
  protocol: SolanaMeasuredExecutionTargetSchema.shape.protocol,
  chain: z.literal("solana"),
  poolId: SolanaAddressSchema,
  poolType: SolanaMeasuredExecutionTargetSchema.shape.poolType,
  tokenIn: SolanaMeasuredExecutionTokenSchema,
  tokenOut: SolanaMeasuredExecutionTokenSchema,
  retainedTvlUsdAtQuote: z.number().finite().positive(),
  retainedPoolPriceUsdAtQuote: z.number().finite().positive(),
  quotedAt: z.number().int().nonnegative(),
  slotWindow: z.object({
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
  }),
  maxCostBps: z.literal(DEX_MEASURED_MAX_COST_BPS),
  marginalOutputRatio: z.number().finite().nonnegative(),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).length(DEX_MEASURED_CAPACITY_NOTIONALS_USD.length),
  quoteProof: z.array(SolanaMeasuredExecutionQuotePointProofSchema).min(1).max(8),
});
export type SolanaMeasuredExecutionProfile = z.infer<typeof SolanaMeasuredExecutionProfileSchema>;

export const SolanaMeasuredExecutionPublicProfileSchema = SolanaMeasuredExecutionProfileSchema.omit({
  quoteProof: true,
});
export type SolanaMeasuredExecutionPublicProfile = z.infer<typeof SolanaMeasuredExecutionPublicProfileSchema>;

export function toSolanaMeasuredExecutionPublicProfile(
  input: SolanaMeasuredExecutionProfile,
): SolanaMeasuredExecutionPublicProfile {
  const parsed = SolanaMeasuredExecutionProfileSchema.parse(input);
  const { quoteProof: _quoteProof, ...profile } = parsed;
  return SolanaMeasuredExecutionPublicProfileSchema.parse(profile);
}

/** Native Solana identifiers are intentionally not lowercased. */
export function buildSolanaMeasuredExecutionTargetId(input: {
  stablecoinId: string;
  adapterProfileId: SolanaMeasuredExecutionTarget["adapterProfileId"];
  protocol: SolanaMeasuredExecutionTarget["protocol"];
  poolId: string;
  tokenInAddress: string;
  tokenOutAddress: string;
}): string {
  return [
    SOLANA_MEASURED_TARGET_SCHEMA_VERSION,
    input.adapterProfileId,
    input.stablecoinId.trim().toLowerCase(),
    "solana",
    input.protocol,
    input.poolId.trim(),
    input.tokenInAddress.trim(),
    input.tokenOutAddress.trim(),
  ].join("|");
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
    if (amount < 0n || priceScaled <= 0n) return null;
    const usdScaled = (amount * priceScaled * usdScale) / (10n ** BigInt(decimals) * priceScale);
    const usd = Number(usdScaled) / Number(usdScale);
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch {
    return null;
  }
}

export type SolanaMeasuredExecutionValidationReason =
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
  | "invalid-slot-proof";

export function validateSolanaMeasuredExecutionProfile(input: {
  profile: unknown;
  quotedTarget: SolanaMeasuredExecutionTarget;
  currentTarget: SolanaMeasuredExecutionTarget;
  expectedTargetGenerationId: string;
  expectedQuoteGenerationId: string;
  nowSec: number;
}): SolanaMeasuredExecutionValidationReason[] {
  const parsed = SolanaMeasuredExecutionProfileSchema.safeParse(input.profile);
  if (!parsed.success) return ["invalid-profile"];
  const profile = parsed.data;
  const quotedTarget = input.quotedTarget;
  const currentTarget = input.currentTarget;
  const issues = new Set<SolanaMeasuredExecutionValidationReason>();

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

  const currentIdentityMatches =
    profile.targetId === currentTarget.targetId &&
    profile.adapterProfileId === currentTarget.adapterProfileId &&
    profile.protocol === currentTarget.protocol &&
    profile.poolId === currentTarget.poolId &&
    profile.poolType === currentTarget.poolType &&
    profile.tokenIn.address === currentTarget.tokenIn.address &&
    profile.tokenOut.address === currentTarget.tokenOut.address &&
    profile.tokenIn.symbol === currentTarget.tokenIn.symbol &&
    profile.tokenOut.symbol === currentTarget.tokenOut.symbol &&
    profile.tokenIn.decimals === currentTarget.tokenIn.decimals &&
    profile.tokenOut.decimals === currentTarget.tokenOut.decimals &&
    profile.tokenIn.trackedAssetId === currentTarget.tokenIn.trackedAssetId &&
    profile.tokenOut.trackedAssetId === currentTarget.tokenOut.trackedAssetId;
  if (!currentIdentityMatches) issues.add("identity-mismatch");
  if (relativeDifference(profile.retainedTvlUsdAtQuote, currentTarget.retainedTvlUsd) > 0.2) {
    issues.add("retained-tvl-mismatch");
  }
  if (relativeDifference(profile.retainedPoolPriceUsdAtQuote, currentTarget.retainedPoolPriceUsd) > 0.02) {
    issues.add("retained-price-mismatch");
  }
  if (
    relativeDifference(profile.tokenIn.referencePriceUsd, currentTarget.tokenIn.referencePriceUsd) > 0.02 ||
    relativeDifference(profile.tokenOut.referencePriceUsd, currentTarget.tokenOut.referencePriceUsd) > 0.02
  )
    issues.add("token-reference-price-mismatch");

  if (
    profile.slotWindow.after < profile.slotWindow.before ||
    profile.slotWindow.after - profile.slotWindow.before > SOLANA_MEASURED_MAX_SLOT_WINDOW
  )
    issues.add("invalid-slot-proof");

  const recomputedProof = profile.quoteProof.map((point) => {
    const inputUsd = rawAmountToUsd(point.amountInRaw, profile.tokenIn.decimals, profile.tokenIn.referencePriceUsd);
    const outputUsd = rawAmountToUsd(point.amountOutRaw, profile.tokenOut.decimals, profile.tokenOut.referencePriceUsd);
    if (inputUsd == null || outputUsd == null || inputUsd <= 0) return null;
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return { inputUsd, outputUsd, costBps, passesCostBound: costBps <= profile.maxCostBps };
  });

  profile.quoteProof.forEach((point, index) => {
    const recomputed = recomputedProof[index];
    const route = point.route;
    if (
      recomputed == null ||
      point.amountInRaw !== route.inputAmount ||
      point.amountOutRaw !== route.outputAmount ||
      route.poolId !== profile.poolId ||
      route.inputMint !== profile.tokenIn.address ||
      route.outputMint !== profile.tokenOut.address ||
      Math.abs((recomputed?.inputUsd ?? 0) - point.inputUsd) > 0.02 ||
      Math.abs((recomputed?.outputUsd ?? 0) - point.outputUsd) > 0.02 ||
      Math.abs((recomputed?.costBps ?? 0) - point.costBps) > 0.02 ||
      recomputed?.passesCostBound !== point.passesCostBound
    )
      issues.add("invalid-quote-proof");

    if (profile.adapterProfileId === "raydium-clmm-trade-api-v1") {
      if (route.provider !== "raydium-trade-api") issues.add("invalid-quote-proof");
    } else if (route.provider !== "jupiter-swap-api") {
      issues.add("invalid-quote-proof");
    } else if (
      route.contextSlot + SOLANA_MEASURED_MAX_CONTEXT_SLOT_LAG < profile.slotWindow.before ||
      route.contextSlot > profile.slotWindow.after + SOLANA_MEASURED_MAX_CONTEXT_SLOT_LEAD
    ) {
      issues.add("invalid-slot-proof");
    }
  });

  const marginal = recomputedProof[0];
  if (marginal == null || Math.abs(profile.marginalOutputRatio - marginal.outputUsd / marginal.inputUsd) > 0.000001)
    issues.add("invalid-quote-proof");
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
  )
    issues.add("invalid-quote-proof");

  const expectedTargetId = buildSolanaMeasuredExecutionTargetId({
    stablecoinId: profile.tokenIn.trackedAssetId ?? "",
    adapterProfileId: profile.adapterProfileId,
    protocol: profile.protocol,
    poolId: profile.poolId,
    tokenInAddress: profile.tokenIn.address,
    tokenOutAddress: profile.tokenOut.address,
  });
  if (profile.targetId !== expectedTargetId) issues.add("identity-mismatch");

  return [...issues];
}
