import {
  DEX_MEASURED_FRESHNESS_MAX_SEC,
  DEX_MEASURED_MARGINAL_NOTIONAL_USD,
  DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO,
  buildDexMeasuredCapacityCurve,
  dexMeasuredCapacityPointMatchesProof,
  getDexMeasuredExecutionProbeNotionals,
} from "./measured-execution";

export interface NativeMeasuredExecutionToken {
  address: string;
  symbol: string;
  decimals: number;
  referencePriceUsd: number;
  trackedAssetId?: string;
}

export interface NativeMeasuredExecutionTarget {
  targetId: string;
  stablecoinId: string;
  adapterProfileId: string;
  protocol: string;
  poolId: string;
  poolType: string;
  tokenIn: NativeMeasuredExecutionToken;
  tokenOut: NativeMeasuredExecutionToken;
  retainedTvlUsd: number;
  retainedPoolPriceUsd: number;
  capturedAt: number;
}

export interface NativeMeasuredExecutionQuotePoint {
  amountInRaw: string;
  amountOutRaw: string;
  inputUsd: number;
  outputUsd: number;
  costBps: number;
  passesCostBound: boolean;
}

export interface NativeMeasuredExecutionProfile<
  TQuotePoint extends NativeMeasuredExecutionQuotePoint,
> {
  targetId: string;
  targetGenerationId: string;
  quoteGenerationId: string;
  adapterProfileId: string;
  protocol: string;
  poolId: string;
  poolType: string;
  tokenIn: NativeMeasuredExecutionToken;
  tokenOut: NativeMeasuredExecutionToken;
  retainedTvlUsdAtQuote: number;
  retainedPoolPriceUsdAtQuote: number;
  quotedAt: number;
  maxCostBps: number;
  marginalOutputRatio: number;
  capacityCurve: readonly {
    requestedNotionalUsd: number;
    maxCostBps: number;
    executableUsd: number;
    completionRatio: number;
    executionCostBps?: number;
  }[];
  quoteProof: readonly TQuotePoint[];
}

export type NativeMeasuredExecutionValidationReason =
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
  | "invalid-quote-proof";

export interface RecomputedNativeMeasuredExecutionQuotePoint {
  inputUsd: number;
  outputUsd: number;
  costBps: number;
  passesCostBound: boolean;
}

export interface NativeMeasuredExecutionValidationAdapter<
  TTarget extends NativeMeasuredExecutionTarget,
  TQuotePoint extends NativeMeasuredExecutionQuotePoint,
  TProfile extends NativeMeasuredExecutionProfile<TQuotePoint>,
  TReason extends string,
> {
  currentIdentityMatches(profile: TProfile, currentTarget: TTarget): boolean;
  validateProfileProof?(
    profile: TProfile,
    issues: Set<TReason>,
  ): void;
  validateQuoteProof(
    input: {
      profile: TProfile;
      currentTarget: TTarget;
      point: TQuotePoint;
      recomputed: RecomputedNativeMeasuredExecutionQuotePoint | null;
    },
    issues: Set<TReason>,
  ): void;
  buildTargetId(profile: TProfile): string;
}

export function nativeMeasuredExecutionRelativeDifference(left: number, right: number): number {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left <= 0 || right <= 0) return Infinity;
  return Math.abs(left / right - 1);
}

export function nativeMeasuredExecutionRawAmountToUsd(
  rawAmount: string,
  decimals: number,
  referencePriceUsd: number,
): number | null {
  try {
    const amount = BigInt(rawAmount);
    const priceScale = 100_000_000n;
    const usdScale = 1_000_000n;
    const priceScaled = BigInt(Math.round(referencePriceUsd * Number(priceScale)));
    if (amount < 0n || priceScaled <= 0n) return null;
    const usdScaled = amount * priceScaled * usdScale / (10n ** BigInt(decimals) * priceScale);
    const usd = Number(usdScaled) / Number(usdScale);
    return Number.isFinite(usd) && usd >= 0 ? usd : null;
  } catch {
    return null;
  }
}

export function validateNativeMeasuredExecutionProfile<
  TTarget extends NativeMeasuredExecutionTarget,
  TQuotePoint extends NativeMeasuredExecutionQuotePoint,
  TProfile extends NativeMeasuredExecutionProfile<TQuotePoint>,
  TReason extends string,
>(input: {
  profile: TProfile;
  quotedTarget: TTarget;
  currentTarget: TTarget;
  expectedTargetGenerationId: string;
  expectedQuoteGenerationId: string;
  nowSec: number;
  adapter: NativeMeasuredExecutionValidationAdapter<TTarget, TQuotePoint, TProfile, TReason>;
}): TReason[] {
  const profile = input.profile;
  const quotedTarget = input.quotedTarget;
  const currentTarget = input.currentTarget;
  const issues = new Set<TReason>();
  const add = (reason: NativeMeasuredExecutionValidationReason) => issues.add(reason as TReason);

  if (profile.targetGenerationId !== input.expectedTargetGenerationId) add("target-generation-mismatch");
  if (profile.quoteGenerationId !== input.expectedQuoteGenerationId) add("quote-generation-mismatch");
  if (profile.tokenIn.trackedAssetId !== currentTarget.stablecoinId) add("tracked-input-mismatch");
  if (profile.quotedAt > input.nowSec + 60) add("future-observation");
  if (profile.quotedAt < quotedTarget.capturedAt) add("observation-before-target");
  if (input.nowSec - profile.quotedAt > DEX_MEASURED_FRESHNESS_MAX_SEC) add("stale-observation");

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
  if (!snapshotMatches) add("target-snapshot-mismatch");

  if (!input.adapter.currentIdentityMatches(profile, currentTarget)) add("identity-mismatch");
  if (nativeMeasuredExecutionRelativeDifference(profile.retainedTvlUsdAtQuote, currentTarget.retainedTvlUsd) > 0.2) {
    add("retained-tvl-mismatch");
  }
  if (
    nativeMeasuredExecutionRelativeDifference(
      profile.retainedPoolPriceUsdAtQuote,
      currentTarget.retainedPoolPriceUsd,
    ) > 0.02
  ) {
    add("retained-price-mismatch");
  }
  if (
    nativeMeasuredExecutionRelativeDifference(
      profile.tokenIn.referencePriceUsd,
      currentTarget.tokenIn.referencePriceUsd,
    ) > 0.02 ||
    nativeMeasuredExecutionRelativeDifference(
      profile.tokenOut.referencePriceUsd,
      currentTarget.tokenOut.referencePriceUsd,
    ) > 0.02
  ) {
    add("token-reference-price-mismatch");
  }

  input.adapter.validateProfileProof?.(profile, issues);

  const recomputedProof = profile.quoteProof.map((point) => {
    const inputUsd = nativeMeasuredExecutionRawAmountToUsd(
      point.amountInRaw,
      profile.tokenIn.decimals,
      profile.tokenIn.referencePriceUsd,
    );
    const outputUsd = nativeMeasuredExecutionRawAmountToUsd(
      point.amountOutRaw,
      profile.tokenOut.decimals,
      profile.tokenOut.referencePriceUsd,
    );
    if (inputUsd == null || outputUsd == null || inputUsd <= 0) return null;
    const costBps = Math.max(0, (1 - outputUsd / inputUsd) * 10_000);
    return { inputUsd, outputUsd, costBps, passesCostBound: costBps <= profile.maxCostBps };
  });

  profile.quoteProof.forEach((point, index) => {
    const recomputed = recomputedProof[index] ?? null;
    if (
      recomputed == null ||
      Math.abs((recomputed?.inputUsd ?? 0) - point.inputUsd) > 0.02 ||
      Math.abs((recomputed?.outputUsd ?? 0) - point.outputUsd) > 0.02 ||
      Math.abs((recomputed?.costBps ?? 0) - point.costBps) > 0.02 ||
      recomputed?.passesCostBound !== point.passesCostBound
    ) {
      add("invalid-quote-proof");
    }
    input.adapter.validateQuoteProof({ profile, currentTarget, point, recomputed }, issues);
  });

  const marginal = recomputedProof[0];
  if (
    marginal == null ||
    Math.abs(profile.marginalOutputRatio - marginal.outputUsd / marginal.inputUsd) > 0.000001
  ) {
    add("invalid-quote-proof");
  }
  if (
    marginal == null ||
    marginal.outputUsd / marginal.inputUsd > DEX_MEASURED_MAX_FAVORABLE_OUTPUT_RATIO
  ) {
    add("quote-price-mismatch");
  }

  const rebuiltCurve = buildDexMeasuredCapacityCurve(
    recomputedProof.filter((point): point is NonNullable<typeof point> => point != null),
    profile.retainedTvlUsdAtQuote,
  );
  if (
    rebuiltCurve.some(
      (point, index) => !dexMeasuredCapacityPointMatchesProof(profile.capacityCurve[index], point),
    )
  ) {
    add("invalid-capacity-curve");
  }

  const sorted = [...profile.quoteProof].sort((left, right) => left.inputUsd - right.inputUsd);
  const probeNotionals = getDexMeasuredExecutionProbeNotionals(profile.retainedTvlUsdAtQuote);
  let stopped = false;
  for (const notional of probeNotionals) {
    const point = sorted.find((candidate) => Math.abs(candidate.inputUsd - notional) <= 0.02);
    if (stopped ? point != null : point == null) {
      add("invalid-quote-proof");
      break;
    }
    if (point && !point.passesCostBound) stopped = true;
  }
  if (
    Math.abs((sorted[0]?.inputUsd ?? 0) - DEX_MEASURED_MARGINAL_NOTIONAL_USD) > 0.02 ||
    sorted.some((point, index) => index > 0 && point.inputUsd <= sorted[index - 1]!.inputUsd)
  ) {
    add("invalid-quote-proof");
  }

  if (profile.targetId !== input.adapter.buildTargetId(profile)) add("identity-mismatch");

  return [...issues];
}
