import { describe, expect, it } from "vitest";
import {
  POOL_PRICE_COHERENCE_POLICY,
  POOL_PRICE_COHERENCE_REJECT_REASONS,
  evaluatePoolPriceCoherence,
  type PoolPriceCoherenceLegs,
} from "../pool-price-coherence";

// Live GeckoTerminal captures from the Noon USN feedback (2026-09-22/23):
// the Sophon pools published USD prices for both legs while every pair-ratio
// input was null or "0.0", and their USD prints ($0.3323 / $0.3950) were
// contradicted by the pools' own on-chain ticks (0.998 / 1.09).
const SOPHON_BROKEN_SIGNATURE: PoolPriceCoherenceLegs = {
  side: "quote",
  baseTokenPriceUsd: 0.3323456606,
  quoteTokenPriceUsd: 0.3323290599,
  baseTokenPriceQuoteToken: null,
  quoteTokenPriceBaseToken: null,
  baseTokenPriceNativeCurrency: null,
  quoteTokenPriceNativeCurrency: null,
};

const ETH_USN_USDT: PoolPriceCoherenceLegs = {
  side: "base",
  baseTokenPriceUsd: 0.9983207616,
  quoteTokenPriceUsd: 0.998639146775485,
  baseTokenPriceQuoteToken: 0.9997813622,
  quoteTokenPriceBaseToken: 1.0002186856,
  baseTokenPriceNativeCurrency: 0.000364145278132919,
  quoteTokenPriceNativeCurrency: 0.000364224911473213,
};

describe("evaluatePoolPriceCoherence", () => {
  it("rejects the GeckoTerminal broken-price signature with a machine-readable reason", () => {
    expect(evaluatePoolPriceCoherence(SOPHON_BROKEN_SIGNATURE)).toEqual({
      verdict: "reject",
      reason: POOL_PRICE_COHERENCE_REJECT_REASONS.pairRatioUnavailable,
      pairDivergenceBps: null,
    });
  });

  it("admits a coherent pool", () => {
    expect(evaluatePoolPriceCoherence(ETH_USN_USDT)).toEqual({ verdict: "admit", checked: true });
  });

  it("admits a quiet coherent pool: zero activity is not a rejection input", () => {
    // zkSync SyncSwap USN/USDC.e capture: 24h volume 0, ratio fields healthy.
    expect(evaluatePoolPriceCoherence({
      side: "base",
      baseTokenPriceUsd: 1.0018122159,
      quoteTokenPriceUsd: 1.0016693845,
      baseTokenPriceQuoteToken: 1.0005451588,
      quoteTokenPriceBaseToken: 0.9994551383,
      baseTokenPriceNativeCurrency: 0.000401420873955884,
      quoteTokenPriceNativeCurrency: 0.000401202155087959,
    })).toEqual({ verdict: "admit", checked: true });
  });

  it("admits rows whose payload omits every pair-ratio input (guard stays inert)", () => {
    expect(evaluatePoolPriceCoherence({
      side: "base",
      baseTokenPriceUsd: 1.0002,
      quoteTokenPriceUsd: 0.9999,
    })).toEqual({ verdict: "admit", checked: false });
  });

  it("falls back to the native-currency ratio when the pair-ratio fields are null", () => {
    expect(evaluatePoolPriceCoherence({
      side: "quote",
      baseTokenPriceUsd: 2,
      quoteTokenPriceUsd: 1,
      baseTokenPriceQuoteToken: null,
      quoteTokenPriceBaseToken: null,
      baseTokenPriceNativeCurrency: 1,
      quoteTokenPriceNativeCurrency: 0.5,
    })).toEqual({ verdict: "admit", checked: true });
  });

  it("rejects when the tracked leg diverges from pool ratio × counter-leg USD beyond the threshold", () => {
    expect(evaluatePoolPriceCoherence({
      side: "base",
      baseTokenPriceUsd: 0.5,
      quoteTokenPriceUsd: 1,
      baseTokenPriceQuoteToken: 1,
      quoteTokenPriceBaseToken: 1,
      baseTokenPriceNativeCurrency: 0.0004,
      quoteTokenPriceNativeCurrency: 0.0004,
    })).toEqual({
      verdict: "reject",
      reason: POOL_PRICE_COHERENCE_REJECT_REASONS.pairPriceIncoherent,
      pairDivergenceBps: 5000,
    });
  });

  it("admits a tracked-leg price just inside the policy divergence threshold", () => {
    const withinBps = POOL_PRICE_COHERENCE_POLICY.maxPairDivergenceBps / 10_000;
    expect(evaluatePoolPriceCoherence({
      side: "base",
      baseTokenPriceUsd: 1 * (1 - withinBps * 0.99),
      quoteTokenPriceUsd: 1,
      baseTokenPriceQuoteToken: 1,
      quoteTokenPriceBaseToken: 1,
      baseTokenPriceNativeCurrency: 0.0004,
      quoteTokenPriceNativeCurrency: 0.0004,
    })).toEqual({ verdict: "admit", checked: true });
  });
});

describe("pool price coherence registry integrity (ADR-32)", () => {
  it("owns a frozen threshold within a sane band", () => {
    expect(Object.isFrozen(POOL_PRICE_COHERENCE_POLICY)).toBe(true);
    expect(POOL_PRICE_COHERENCE_POLICY.maxPairDivergenceBps).toBeGreaterThan(0);
    expect(POOL_PRICE_COHERENCE_POLICY.maxPairDivergenceBps).toBeLessThanOrEqual(10_000);
  });

  it("owns a frozen, unique, non-empty rejection vocabulary", () => {
    expect(Object.isFrozen(POOL_PRICE_COHERENCE_REJECT_REASONS)).toBe(true);
    const reasons = Object.values(POOL_PRICE_COHERENCE_REJECT_REASONS);
    expect(reasons.every((reason) => typeof reason === "string" && reason.length > 0)).toBe(true);
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});
