import { logWorkerEventArgs } from "../../lib/structured-log";

/**
 * Pool price coherence policy — single owning registry (ADR-32) for the
 * thresholds, rejection vocabulary, and admission gate used by GeckoTerminal /
 * CoinGecko onchain pool admission (the GT crawl in `crawl-helpers.ts` and the
 * CG onchain crawl in `dex-discovery/crawl-coingecko-pools.ts`).
 *
 * The guarded failure mode is a provider pricing break on one leg of the
 * pair: the tracked leg's USD price must stay coherent with the pool's own
 * pair ratio times the counter-leg's USD price. The primary trigger is the
 * GeckoTerminal broken-price signature — the provider still publishes USD
 * prices for both legs while every pair-ratio input it normally derives them
 * from (the pair-ratio fields and the native-currency prices) is null or
 * "0.0". Observed live: Sophon USDT/USN and sUSN/USN pools printing
 * $0.3323/$0.3950 against an on-chain tick of ~0.998/1.09.
 *
 * Zero volume and zero transactions are never an independent rejection:
 * pool prices come from reserves, and quiet pools are legitimate.
 */

export const POOL_PRICE_COHERENCE_POLICY = Object.freeze({
  /**
   * Maximum accepted divergence, in bps, between the tracked leg's USD price
   * and the pool's own pair ratio times the counter-leg's USD price. Healthy
   * provider rows are self-consistent to a few bps; the observed Sophon
   * failure was off by thousands of bps.
   */
  maxPairDivergenceBps: 500,
});

export const POOL_PRICE_COHERENCE_REJECT_REASONS = Object.freeze({
  /** The provider published leg USD prices but no usable pair ratio (null/zero pair-ratio and native fields). */
  pairRatioUnavailable: "pool-pair-ratio-unavailable",
  /** The tracked leg's USD price diverges from pool ratio × counter-leg USD beyond the policy threshold. */
  pairPriceIncoherent: "pool-pair-price-incoherent",
});

export type PoolPriceCoherenceRejectReason =
  (typeof POOL_PRICE_COHERENCE_REJECT_REASONS)[keyof typeof POOL_PRICE_COHERENCE_REJECT_REASONS];

/** The parsed-pool price projection both admission paths already carry. */
export interface PoolPriceCoherenceLegs {
  baseTokenPriceUsd: number;
  quoteTokenPriceUsd: number;
  /** Price of one base token in quote tokens; `undefined` when the payload omits the field, `null` when present but unusable. */
  baseTokenPriceQuoteToken?: number | null;
  quoteTokenPriceBaseToken?: number | null;
  baseTokenPriceNativeCurrency?: number | null;
  quoteTokenPriceNativeCurrency?: number | null;
}

export type PoolPriceCoherenceDecision =
  | { verdict: "admit"; checked: false }
  | { verdict: "admit"; checked: true }
  | { verdict: "reject"; reason: PoolPriceCoherenceRejectReason; pairDivergenceBps: number | null };

function isUsableRatio(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Verdict for one pool observation. Rows whose payload carries none of the
 * pair-ratio inputs are admitted unchecked (the guard stays inert for
 * providers that omit the fields) instead of being misread as broken.
 */
export function evaluatePoolPriceCoherence(
  side: "base" | "quote",
  legs: PoolPriceCoherenceLegs,
): PoolPriceCoherenceDecision {
  const ratioProvided =
    legs.baseTokenPriceQuoteToken !== undefined ||
    legs.quoteTokenPriceBaseToken !== undefined ||
    legs.baseTokenPriceNativeCurrency !== undefined ||
    legs.quoteTokenPriceNativeCurrency !== undefined;
  if (!ratioProvided) return { verdict: "admit", checked: false };

  const directRatio = side === "base" ? legs.baseTokenPriceQuoteToken : legs.quoteTokenPriceBaseToken;
  const nativeRatio =
    isUsableRatio(legs.baseTokenPriceNativeCurrency) && isUsableRatio(legs.quoteTokenPriceNativeCurrency)
      ? side === "base"
        ? legs.baseTokenPriceNativeCurrency / legs.quoteTokenPriceNativeCurrency
        : legs.quoteTokenPriceNativeCurrency / legs.baseTokenPriceNativeCurrency
      : null;
  const ratio = isUsableRatio(directRatio) ? directRatio : nativeRatio;
  if (ratio == null) {
    // The broken-price signature: the row still ships USD prices while the
    // provider cannot produce any pair ratio for it, so the USD pair is
    // unverifiable and its `reserve_in_usd` is equally suspect.
    return {
      verdict: "reject",
      reason: POOL_PRICE_COHERENCE_REJECT_REASONS.pairRatioUnavailable,
      pairDivergenceBps: null,
    };
  }

  const trackedUsd = side === "base" ? legs.baseTokenPriceUsd : legs.quoteTokenPriceUsd;
  const counterUsd = side === "base" ? legs.quoteTokenPriceUsd : legs.baseTokenPriceUsd;
  if (!isUsableRatio(trackedUsd) || !isUsableRatio(counterUsd)) {
    // Nothing to cross-check (existing paths already tolerate a missing leg
    // price); the ratio itself is healthy, so the row stays admissible.
    return { verdict: "admit", checked: true };
  }

  const pairDivergenceBps = Math.abs(trackedUsd / (ratio * counterUsd) - 1) * 10_000;
  if (pairDivergenceBps > POOL_PRICE_COHERENCE_POLICY.maxPairDivergenceBps) {
    return {
      verdict: "reject",
      reason: POOL_PRICE_COHERENCE_REJECT_REASONS.pairPriceIncoherent,
      pairDivergenceBps,
    };
  }
  return { verdict: "admit", checked: true };
}

export interface PoolPriceCoherenceAdmissionGate {
  /** True when the pool may be admitted. Rejections are tallied by machine-readable reason. */
  admits(side: "base" | "quote", legs: PoolPriceCoherenceLegs): boolean;
  /** Emits one warn line per run when anything was rejected, or nothing at all. */
  flush(): void;
}

/**
 * Run-scoped admission gate shared by both crawl paths: records every
 * rejection with its machine-readable reason (R4) and reports one aggregate
 * warn line through the existing structured-log pattern.
 */
export function createPoolPriceCoherenceAdmissionGate(
  logScope: string,
  sourceLabel: string,
): PoolPriceCoherenceAdmissionGate {
  const rejectedByReason = new Map<PoolPriceCoherenceRejectReason, number>();
  return {
    admits(side, legs) {
      const decision = evaluatePoolPriceCoherence(side, legs);
      if (decision.verdict === "admit") return true;
      rejectedByReason.set(decision.reason, (rejectedByReason.get(decision.reason) ?? 0) + 1);
      return false;
    },
    flush() {
      if (rejectedByReason.size === 0) return;
      logWorkerEventArgs("handler", "warn",
        `[${logScope}] ${sourceLabel} rejected incoherent pool prices by reason: ${JSON.stringify(Object.fromEntries(rejectedByReason))}`,
      );
    },
  };
}
