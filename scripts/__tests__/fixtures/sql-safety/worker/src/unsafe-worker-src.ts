export function buildUnsafeWorkerSrcQuery(tableName: string): string {
  return `SELECT * FROM ${tableName} WHERE deleted_at IS NULL`;
}
