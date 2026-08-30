import { chunkArray as chunkArrayShared } from "@shared/lib/collections";

export const D1_SAFE_IN_CLAUSE_BIND_LIMIT = 90;

export function chunkArray<T>(
  values: readonly T[],
  chunkSize: number = D1_SAFE_IN_CLAUSE_BIND_LIMIT,
): T[][] {
  return chunkArrayShared(values, chunkSize);
}
