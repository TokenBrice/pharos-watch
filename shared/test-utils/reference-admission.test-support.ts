import type { ReferenceAdmission } from "../types/reference-admission";

export const FX_REOPEN_QUOTE_AT = Date.parse("2026-11-16T14:00:00Z") / 1000;

export function makeFxAdmission(status: "admitted" | "stale-reference", at = FX_REOPEN_QUOTE_AT): ReferenceAdmission {
  const evidence = {
    kind: "fx",
    source: "openExchangeRates",
    cadence: "intraday",
    referenceObservedAtSec: at - (status === "admitted" ? 60 : 3 * 86_400),
    quoteObservedAtSec: at,
    decisionAtSec: at,
    budgetSec: 7200,
    sessionOpenedAtSec: at - 16 * 3600,
    generation: "fx-reopen-test",
    policyVersion: 1,
  } as const;
  return status === "admitted"
    ? { ...evidence, status, reason: "live-reference" }
    : { ...evidence, status, reason: "reference-before-reopen" };
}

export function makeFxCurrentPeg(status: "admitted" | "stale-reference", deviation: number | null, at = FX_REOPEN_QUOTE_AT) {
  const referenceAdmission = makeFxAdmission(status, at);
  return {
    currentDeviationBps: 200,
    pegReference: { valueUsd: 1.1, source: "fx", contributorCount: 0, asOf: referenceAdmission.referenceObservedAtSec! },
    pegReferenceUnavailable: false,
    currentPriceUnavailable: false,
    primaryTrust: "unusable",
    dexPriceCheck: null,
    admittedDeviationBps: deviation,
    referenceAdmission,
  } as const;
}
