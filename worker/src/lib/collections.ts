export const D1_SAFE_IN_CLAUSE_BIND_LIMIT = 90;

export function chunkArray<T>(
  values: readonly T[],
  chunkSize: number = D1_SAFE_IN_CLAUSE_BIND_LIMIT,
): T[][] {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`chunkArray requires a positive integer chunkSize (received ${chunkSize})`);
  }
  if (values.length === 0) return [];

  const chunks: T[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}
