import { D1_BATCH_SIZE } from "./constants";
import { runWithOverloadRetry } from "./d1-overload-retry";

export const D1_MAX_BOUND_PARAMETERS = 100;
export interface BatchExecuteOptions { chunkSize?: number; signal?: AbortSignal }

/** Execute D1 prepared statements in chunks to stay within the batch limit */
export async function batchExecute(
  db: D1Database,
  stmts: D1PreparedStatement[],
  optionsOrChunkSize: number | BatchExecuteOptions = D1_BATCH_SIZE,
): Promise<number> {
  const options = typeof optionsOrChunkSize === "number" ? { chunkSize: optionsOrChunkSize } : optionsOrChunkSize;
  const chunkSize = options.chunkSize ?? D1_BATCH_SIZE;
  const signal = options.signal;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new RangeError(`batchExecute requires a positive integer chunkSize (received ${chunkSize})`);
  }
  let changes = 0;
  for (let index = 0; index < stmts.length; index += chunkSize) {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const results = await runWithOverloadRetry(() => db.batch(stmts.slice(index, index + chunkSize)), 3, signal);
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    for (const row of results) {
      changes += Number(row?.meta?.changes ?? 0);
    }
  }
  return changes;
}

/**
 * Build a safe SQL IN-clause with parameterized placeholders.
 * Returns the SQL fragment (e.g. "?,?,?") and the bind values.
 */
export function buildInClause(values: readonly unknown[]): { sql: string; binds: unknown[] } {
  if (values.length === 0) throw new Error("buildInClause: empty array");
  if (values.length > D1_MAX_BOUND_PARAMETERS) {
    throw new Error(`buildInClause: ${values.length} values exceeds D1 bound-parameter limit ${D1_MAX_BOUND_PARAMETERS}`);
  }
  return { sql: new Array(values.length).fill("?").join(","), binds: [...values] };
}
