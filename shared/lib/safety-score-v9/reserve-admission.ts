import policy from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { isValidIsoDateOnly, parseIsoDateOrUtcInstantSec, reviewAdmissionSec } from "../../types/date-primitives";
import type { ReserveCompositionReviewBlocker } from "../../types/safety-score-v9-public";
import {
  isSecEdgarDataUrl,
  RESERVE_COMPOSITION_FILING_FORM_VALUES,
  RESERVE_COMPOSITION_FILING_REGULATOR_VALUES,
  SEC_ACCESSION_PATTERN,
  type ReserveReview,
} from "../../types/stablecoin-meta-primitives";

const expiry = policy.semantic.evidence.evidenceExpiry;
const NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC = expiry.namedFirmReserveReportMaxAgeSec;
// Monthly reports commonly land in the first week after month-end.
export const REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC =
  expiry.reviewedReserveCompositionMaxAgeSec + expiry.reviewedReserveCompositionGraceSec;
const REGULATOR_PERIODIC_FILING_COMPOSITION_MAX_AGE_SEC =
  expiry.regulatorPeriodicFilingCompositionMaxAgeSec;

const REGULATOR_SET: ReadonlySet<string> = new Set(RESERVE_COMPOSITION_FILING_REGULATOR_VALUES);
const FORM_SET: ReadonlySet<string> = new Set(RESERVE_COMPOSITION_FILING_FORM_VALUES);

export interface ReviewedReserveCompositionBudget {
  maxAgeSec: number;
  filingAdmissible: boolean;
}

export function isValidReserveCompositionFiling(review: ReserveReview | undefined): boolean {
  const filing = review?.compositionFiling;
  if (!review || !filing) return false;
  if (review.scope !== "full-composition" || !review.compositionAsOf) return false;
  if (!REGULATOR_SET.has(filing.regulator) || !FORM_SET.has(filing.form)) return false;
  if (!SEC_ACCESSION_PATTERN.test(filing.accession)) return false;
  if (!isValidIsoDateOnly(filing.periodEnd) || !isValidIsoDateOnly(filing.filedAt)) return false;
  if (filing.periodEnd !== review.compositionAsOf) return false;
  if (filing.filedAt < filing.periodEnd) return false;
  const reviewedAtSec = parseIsoDateOrUtcInstantSec(review.reviewedAt);
  const filedAtSec = parseIsoDateOrUtcInstantSec(filing.filedAt);
  if (!Number.isFinite(reviewedAtSec) || !Number.isFinite(filedAtSec) || filedAtSec > reviewedAtSec) return false;
  if (!isSecEdgarDataUrl(filing.url)) return false;
  return review.sources.some((source) => source.url === filing.url);
}

/**
 * Single authority for curated reviewed-composition admission age budgets.
 * When `clockSec` is provided, a regulator-filed periodic report is admissible
 * only after its date-only `filedAt` UTC day has elapsed (matching the repo's
 * `reviewAdmissionSec` convention). Passing `clockSec: null` is reserved for
 * clock-free client summary projections.
 */
export function resolveReviewedReserveCompositionBudget(
  review: ReserveReview | undefined,
  clockSec: number | null,
): ReviewedReserveCompositionBudget {
  if (!isValidReserveCompositionFiling(review)) {
    return {
      maxAgeSec: REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC,
      filingAdmissible: false,
    };
  }
  if (clockSec !== null) {
    const filingAdmissionSec = reviewAdmissionSec(review!.compositionFiling!.filedAt);
    if (!Number.isFinite(clockSec) || !Number.isFinite(filingAdmissionSec) || clockSec < filingAdmissionSec) {
      return {
        maxAgeSec: REVIEWED_RESERVE_COMPOSITION_ADMISSION_MAX_AGE_SEC,
        filingAdmissible: false,
      };
    }
  }
  return {
    maxAgeSec: REGULATOR_PERIODIC_FILING_COMPOSITION_MAX_AGE_SEC,
    filingAdmissible: true,
  };
}

/**
 * Single authority for the named-firm report admission age budget.
 * An admissible Form 10-K `compositionFiling` whose `periodEnd` equals the
 * named report's `periodEnd` (on a verified review) receives the greater of
 * the named-firm budget (120 d) and the periodic-filing budget (135 d).
 */
export function resolveNamedFirmReserveReportMaxAgeSec(
  review: ReserveReview | undefined,
  reportPeriodEnd: string | undefined,
  clockSec: number | null,
): number {
  const filing = review?.compositionFiling;
  if (
    review?.confidence === "verified" &&
    filing?.form === "10-K" &&
    reportPeriodEnd != null &&
    reportPeriodEnd === filing.periodEnd
  ) {
    const budget = resolveReviewedReserveCompositionBudget(review, clockSec);
    if (budget.filingAdmissible) {
      return Math.max(NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC, budget.maxAgeSec);
    }
  }
  return NAMED_FIRM_RESERVE_REPORT_MAX_AGE_SEC;
}

export function projectReserveCompositionReviewFacts(review: ReserveReview) {
  const blockers: ReserveCompositionReviewBlocker[] = [];
  if (review.scope == null) blockers.push("scope-missing");
  else if (review.scope !== "full-composition") blockers.push(review.scope);
  if (review.confidence !== "verified") blockers.push("unverified");
  const compositionAtMs = review.compositionAsOf ? Date.parse(review.compositionAsOf) : Number.NaN;
  const compositionAtSec = Number.isFinite(compositionAtMs) ? Math.floor(compositionAtMs / 1_000) : null;
  if (compositionAtSec === null) blockers.push("undated");
  return { blockers, compositionAtSec };
}
