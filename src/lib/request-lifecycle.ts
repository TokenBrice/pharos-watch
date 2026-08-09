import { mergeAbortSignals, staticAbortSignal, type MergedAbortSignal } from "@shared/lib/abort-signals";

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export function normalizeRequestTimeoutMs(timeoutMs: number | null | undefined): number | null {
  if (timeoutMs === null) return null;
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(1, Math.ceil(timeoutMs));
}

export type RequestSignalPolicy = "explicit-over-init" | "compose";

/**
 * Resolve the signal a request should carry. Callers must `dispose()` the
 * result once the request settles — under the `"compose"` policy the merge can
 * hold listeners on the caller's signals until then.
 */
export function resolveRequestSignal(
  initSignal: AbortSignal | null | undefined,
  explicitSignal: AbortSignal | null | undefined,
  policy: RequestSignalPolicy,
): MergedAbortSignal {
  if (policy === "explicit-over-init") {
    return staticAbortSignal(explicitSignal ?? initSignal ?? undefined);
  }

  return mergeAbortSignals([initSignal, explicitSignal]);
}
