import {
  DEPEG_AUDIT_VERDICT_VALUES,
  DISPUTED_AUDIT_VERDICTS,
  DDR_INELIGIBLE_AUDIT_VERDICTS,
  PEG_SCORE_EXCLUDED_AUDIT_VERDICTS,
} from "../types/depeg-audit";

/** A reviewed dispute is displayed as Disputed; a null or unknown verdict makes no claim. */
export function isDisputedAuditVerdict(verdict: string | null | undefined): boolean {
  return verdict != null && DISPUTED_AUDIT_VERDICTS.some((disputed) => disputed === verdict);
}

export function isPegScoreExcludedAuditVerdict(verdict: string | null | undefined): boolean {
  return verdict != null && (!DEPEG_AUDIT_VERDICT_VALUES.some((known) => known === verdict) || PEG_SCORE_EXCLUDED_AUDIT_VERDICTS.some((excluded) => excluded === verdict));
}

export function isDdrIneligibleAuditVerdict(verdict: string | null | undefined): boolean {
  return verdict != null && (!DEPEG_AUDIT_VERDICT_VALUES.some((known) => known === verdict) || DDR_INELIGIBLE_AUDIT_VERDICTS.some((excluded) => excluded === verdict));
}
