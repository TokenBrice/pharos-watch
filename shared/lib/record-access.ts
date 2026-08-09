/**
 * Nullable-returning companions to the narrowing guards in `type-guards.ts`.
 *
 * Kept in a separate module rather than folded into `type-guards.ts` because
 * that file is pinned by `shared/data/safety-score-v9/evaluation-build-manifest-v1.ts`:
 * appending to it rotates the evaluation-build digest for an unrelated reason.
 * Semantics are delegated, so the two modules cannot drift.
 */

import { isRecord } from "./type-guards";

/** Narrow an unknown to a plain (non-array) record, or null. */
export function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
