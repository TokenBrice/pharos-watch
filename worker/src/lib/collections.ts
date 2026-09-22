import { chunkArray as chunkArrayShared } from "@shared/lib/collections";
import { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "./d1-primitives";

export { D1_SAFE_IN_CLAUSE_BIND_LIMIT } from "./d1-primitives";

export function chunkArray<T>(
  values: readonly T[],
  chunkSize: number = D1_SAFE_IN_CLAUSE_BIND_LIMIT,
): T[][] {
  return chunkArrayShared(values, chunkSize);
}
