import type { ReferenceAdmission } from "../types/reference-admission";

// Inputs only: each boundary suite owns its oracle and reviewed source fixtures.
export const NUMERIC_INPUT_STATES = [
  { state: "absent", value: undefined },
  { state: "null", value: null },
  { state: "nan", value: Number.NaN },
  { state: "infinite", value: Number.POSITIVE_INFINITY },
  { state: "negative", value: -1 },
  { state: "zero", value: 0 },
  { state: "positive", value: 100 },
] as const;

export const READ_INPUT_STATES = ["confirmed-absent", "failed-read"] as const;

export const CLOCK_NOW_SEC = 1_800_000_000;
export const CLOCK_INPUT_STATES = [
  { state: "missing", updatedAt: null, generationId: "generation:current" },
  { state: "future", updatedAt: CLOCK_NOW_SEC + 61, generationId: "generation:current" },
  { state: "expired", updatedAt: CLOCK_NOW_SEC - 61, generationId: "generation:current" },
  { state: "mismatched-generation", updatedAt: CLOCK_NOW_SEC, generationId: "generation:other" },
  { state: "current", updatedAt: CLOCK_NOW_SEC, generationId: "generation:current" },
] as const;

export const FX_REOPEN_QUOTE_AT = Date.parse("2026-11-16T14:00:00Z") / 1000;

export function makeFxCurrentPeg(status: "admitted" | "stale-reference", deviation: number | null, at = FX_REOPEN_QUOTE_AT) {
  const asOf = at - (status === "admitted" ? 60 : 3 * 86_400);
  const evidence = {
    kind: "fx",
    source: "openExchangeRates",
    cadence: "intraday",
    referenceObservedAtSec: asOf,
    quoteObservedAtSec: at,
    decisionAtSec: at,
    budgetSec: 7200,
    sessionOpenedAtSec: at - 16 * 3600,
    generation: "fx-reopen-test",
    policyVersion: 1,
  } as const;
  const referenceAdmission: ReferenceAdmission = status === "admitted"
    ? { ...evidence, status, reason: "live-reference" }
    : { ...evidence, status, reason: "reference-before-reopen" };
  return {
    currentDeviationBps: 200,
    pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf },
    pegReferenceUnavailable: false,
    currentPriceUnavailable: false,
    primaryTrust: "unusable",
    dexPriceCheck: null,
    admittedDeviationBps: deviation,
    referenceAdmission,
  } as const;
}
