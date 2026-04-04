export function buildUnsafeWorkerScriptQuery(tableName: string): string {
  return `DELETE FROM ${tableName} WHERE archived = 0`;
}
