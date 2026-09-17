export function unsafeMultilineQuery(tableName: string): string {
  return `SELECT id
    FROM ${tableName}
    WHERE active = 1`;
}
