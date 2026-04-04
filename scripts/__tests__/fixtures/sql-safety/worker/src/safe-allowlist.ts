const ALLOWED_TABLES = new Set(["allowed_events", "allowed_history"]);

export function buildSafeAllowlistQuery(tableName: string): string {
  if (!ALLOWED_TABLES.has(tableName)) {
    throw new Error("Invalid SQL table name");
  }

  return `SELECT * FROM ${tableName} WHERE archived = 0`;
}
