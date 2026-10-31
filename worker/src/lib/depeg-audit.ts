import {
  DEPEG_AUDIT_VERDICT_VALUES,
  DISPUTED_AUDIT_VERDICTS,
  type DepegAuditVerdict,
} from "@shared/types/depeg-audit";

function auditVerdictInSql(
  column: string,
  verdicts: readonly DepegAuditVerdict[],
): { sql: string; binds: readonly string[] } {
  const identifiers = column.split(".");
  if (identifiers.length > 2 || identifiers.some((identifier) => !/^[a-z_][a-z0-9_]*$/i.test(identifier))) {
    throw new Error("Invalid audit verdict SQL column");
  }
  return {
    sql: `${column} IN (${verdicts.map(() => "?").join(", ")})`,
    binds: verdicts,
  };
}

/** Null is legacy unaudited; unknown non-null verdicts are never eligible. */
export function auditVerdictNotInSql(column: string, excluded: readonly DepegAuditVerdict[]): { sql: string; binds: readonly string[] } {
  const identifiers = column.split(".");
  if (identifiers.length > 2 || identifiers.some((identifier) => !/^[a-z_][a-z0-9_]*$/i.test(identifier))) {
    throw new Error("Invalid audit verdict SQL column");
  }
  const eligible = DEPEG_AUDIT_VERDICT_VALUES.filter((verdict) => !excluded.includes(verdict));
  return {
    sql: `(${column} IS NULL OR ${column} IN (${eligible.map(() => "?").join(", ")}))`,
    binds: eligible,
  };
}

/** Rows whose provenance carries a reviewed dispute; callers subtract these from public event counts. */
export function disputedAuditVerdictSql(column: string): { sql: string; binds: readonly string[] } {
  return auditVerdictInSql(column, DISPUTED_AUDIT_VERDICTS);
}

/** Public event-count eligibility: null and unknown verdicts make no claim and keep counting (R2). */
export function notDisputedAuditVerdictSql(column: string): { sql: string; binds: readonly string[] } {
  const disputed = disputedAuditVerdictSql(column);
  return {
    sql: `(${column} IS NULL OR ${column} NOT IN (${DISPUTED_AUDIT_VERDICTS.map(() => "?").join(", ")}))`,
    binds: disputed.binds,
  };
}
