import type { EvidenceLossDisposition, EvidenceLossLeg, EvidenceLossOutcome } from "../types/evidence-loss";

/** Known adverse evidence wins over operational failures, irrespective of leg order. */
export function deriveDisposition(legs: readonly EvidenceLossLeg[] | null | undefined): EvidenceLossDisposition {
  if (!legs?.length) return "unknown";
  let evidential = false;
  let unknown = false;
  for (const leg of legs) {
    if (leg.disposition === "semantic") return "semantic";
    if (leg.disposition === "evidential") evidential = true;
    if (leg.disposition === "unknown" || !leg.proof?.trim()) unknown = true;
  }
  return evidential ? "evidential" : unknown ? "unknown" : "operational";
}

/** Eligibility only: never mutates prior evidence, rewrites clocks, or enables producer carry. */
export function isCarryEligible(outcome: EvidenceLossOutcome, nowSec: number): boolean {
  const prior = outcome.priorEvidence;
  return !outcome.legacy
    && outcome.disposition === "operational"
    && Boolean(outcome.proof?.trim())
    && deriveDisposition(outcome.legs) === "operational"
    && prior !== null
    && Boolean(prior.ref.trim())
    && Number.isInteger(nowSec) && nowSec >= 0
    && Number.isInteger(prior.observedAtSec) && prior.observedAtSec >= 0
    && Number.isInteger(prior.expiresAtSec)
    && prior.observedAtSec <= nowSec
    && nowSec < prior.expiresAtSec;
}

export interface EvidenceLossSummary {
  total: number;
  byDisposition: Record<EvidenceLossDisposition, number>;
  byReason: { reason: string; count: number }[];
  /** Outcomes whose reason counter was omitted, not a count of unique omitted reasons. */
  omittedReasonCount: number;
}

/**
 * Bounded cron metadata: first-seen reason counters, at most 100 keys of 96 characters.
 * All outcomes still contribute to disposition totals; no asset/proof identities are exposed.
 */
export function summarizeEvidenceLossOutcomes(
  outcomes: Iterable<EvidenceLossOutcome>,
  maxReasons = 20,
): EvidenceLossSummary {
  const limit = Number.isFinite(maxReasons) ? Math.max(0, Math.min(100, Math.floor(maxReasons))) : 20;
  const summary: EvidenceLossSummary = {
    total: 0,
    byDisposition: { operational: 0, evidential: 0, semantic: 0, unknown: 0 },
    byReason: [],
    omittedReasonCount: 0,
  };
  const reasonCounts = new Map<string, number>();
  for (const outcome of outcomes) {
    summary.total++;
    summary.byDisposition[outcome.legacy ? "unknown" : outcome.disposition]++;
    const count = reasonCounts.get(outcome.reason);
    if (count !== undefined) {
      reasonCounts.set(outcome.reason, count + 1);
    } else if (reasonCounts.size < limit && outcome.reason.length <= 96) {
      reasonCounts.set(outcome.reason, 1);
    } else {
      summary.omittedReasonCount++;
    }
  }
  summary.byReason = Array.from(reasonCounts, ([reason, count]) => ({ reason, count }));
  return summary;
}
