import {
  DEPEG_AUDIT_VERDICT_VALUES,
  DDR_INELIGIBLE_AUDIT_VERDICTS,
  PEG_SCORE_EXCLUDED_AUDIT_VERDICTS,
} from "../types/depeg-audit";

export function isPegScoreExcludedAuditVerdict(verdict: string | null | undefined): boolean {
  return verdict != null && (!DEPEG_AUDIT_VERDICT_VALUES.some((known) => known === verdict) || PEG_SCORE_EXCLUDED_AUDIT_VERDICTS.some((excluded) => excluded === verdict));
}

export function isDdrIneligibleAuditVerdict(verdict: string | null | undefined): boolean {
  return verdict != null && (!DEPEG_AUDIT_VERDICT_VALUES.some((known) => known === verdict) || DDR_INELIGIBLE_AUDIT_VERDICTS.some((excluded) => excluded === verdict));
}
