export const DIRECT_API_REQUEST_TIMEOUT_MS = 15_000;
export const DIRECT_API_PROVIDER_TIMEOUT_MS = 90_000;
export const DIRECT_API_FETCH_PHASE_CONCURRENCY = 1;
export const DIRECT_API_DEFAULT_MAX_PAGES = 50;

/**
 * Compose a caller signal with a fixed wall-clock timeout for a single `fetch`.
 *
 * Do not hand the result to `fetchWithRetry`/`fetchTextWithRetry` as
 * `opts.signal`: those helpers compose their own per-attempt timeout, and an
 * already-armed outer abort makes attempt 1 fail and rethrow straight past the
 * retry loop, silently disabling every retry. Give the helper
 * `options.timeoutMs` instead and pass only the phase/cron signal through.
 * Callers that run their own retry loop must rebuild this signal per attempt.
 */
export function buildDirectApiRequestSignal(
  signal?: AbortSignal,
  timeoutMs = DIRECT_API_REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
