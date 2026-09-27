import { DEPEG_AUDIT_VERDICT_VALUES, type DepegAuditVerdict } from "@shared/types/depeg-audit";

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
