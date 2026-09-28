import { z } from "zod";

export const DEPEG_AUDIT_VERDICT_VALUES = [
  "confirmed",
  "disputed",
  "false_positive",
  "no_data",
  "repaired",
] as const;
export const DepegAuditVerdictSchema = z.enum(DEPEG_AUDIT_VERDICT_VALUES);
export type DepegAuditVerdict = z.output<typeof DepegAuditVerdictSchema>;

// Lack of audit data does not negate an observed depeg for PegScore.
export const PEG_SCORE_EXCLUDED_AUDIT_VERDICTS = ["false_positive", "disputed"] as const satisfies readonly DepegAuditVerdict[];
// DDR training/publication requires affirmative usable event provenance.
export const DDR_INELIGIBLE_AUDIT_VERDICTS = [...PEG_SCORE_EXCLUDED_AUDIT_VERDICTS, "no_data"] as const satisfies readonly DepegAuditVerdict[];
