import { z } from "zod";

import { ExitRouteCapacityPointSchema, ExitRouteObservationHistorySchema } from "./exit-route";

export const DEX_MEASURED_EXECUTION_SCHEMA_VERSION = "dex-measured-execution-v1" as const;
export const DEX_MEASURED_TARGET_SCHEMA_VERSION = "dex-measured-target-v1" as const;
export const DEX_MEASURED_MAX_COST_BPS = 200;
export const DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO = 1.02;
export const DEX_MEASURED_MARGINAL_NOTIONAL_USD = 1_000;
export const DEX_MEASURED_CAPACITY_NOTIONALS_USD = [100_000, 1_000_000, 10_000_000, 25_000_000] as const;
export const DEX_MEASURED_FRESHNESS_MAX_SEC = 2 * 30 * 60;
export const DEX_MEASURED_MATURE_SUCCESSFUL_CYCLE_COUNT = 2;

const CanonicalEvmAddressSchema = z.string().regex(/^0x[a-f0-9]{40}$/);

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
export type DexMeasuredExecutionToken = z.infer<typeof DexMeasuredExecutionTokenSchema>;

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
  retainedTvlUsdAtQuote: z.number().finite().positive(),
  retainedPoolPriceUsdAtQuote: z.number().finite().positive(),
  quotedAt: z.number().int().nonnegative(),
  blockNumber: z.number().int().nonnegative(),
  executionEndpoint: z.object({
    address: CanonicalEvmAddressSchema,
    codeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
  }),
  poolBindingProof: DexMeasuredExecutionPoolBindingProofSchema.optional(),
  maxCostBps: z.literal(DEX_MEASURED_MAX_COST_BPS),
  marginalOutputRatio: z.number().finite().nonnegative(),
  capacityCurve: z.array(ExitRouteCapacityPointSchema).length(DEX_MEASURED_CAPACITY_NOTIONALS_USD.length),
  quoteProof: z.array(DexMeasuredExecutionQuotePointProofSchema).min(1).max(16),
});
export type DexMeasuredExecutionProfile = z.infer<typeof DexMeasuredExecutionProfileSchema>;

/** Public, proof-free projection retained on DEX pool rows. */
export const DexMeasuredExecutionPublicProfileSchema = DexMeasuredExecutionProfileSchema.omit({
  quoteProof: true,
  poolBindingProof: true,
}).extend({
  observationHistory: DexMeasuredExecutionObservationHistorySchema.optional(),
  poolProvenance: z.object({
    factoryAddress: CanonicalEvmAddressSchema,
    factoryCodeHash: z.string().regex(/^0x[a-f0-9]{64}$/),
    resolvedPoolAddress: CanonicalEvmAddressSchema,
  }).optional(),
});
export type DexMeasuredExecutionPublicProfile = z.infer<typeof DexMeasuredExecutionPublicProfileSchema>;

export function toDexMeasuredExecutionPublicProfile(
  input: DexMeasuredExecutionProfile,
  options: { observationHistory?: DexMeasuredExecutionObservationHistory } = {},
): DexMeasuredExecutionPublicProfile {
  const parsed = DexMeasuredExecutionProfileSchema.parse(input);
  const { quoteProof: _quoteProof, poolBindingProof, ...profile } = parsed;
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
export function dexMeasuredCapacityPointMatchesProof(
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
  if (input.nowSec - profile.quotedAt > DEX_MEASURED_FRESHNESS_MAX_SEC) issues.add("stale-observation");

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
    profile.tickSpacing === currentTarget.tickSpacing;
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
  });
  if (profile.targetId !== expectedTargetId) {
    issues.add("identity-mismatch");
  }

  return [...issues];
}
