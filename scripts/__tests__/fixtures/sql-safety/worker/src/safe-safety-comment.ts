export function buildSafeCommentQuery(tableName: string): string {
  // SAFETY: the caller validates the table name before interpolation.
  return `SELECT * FROM ${tableName} WHERE archived = 0`;
}
