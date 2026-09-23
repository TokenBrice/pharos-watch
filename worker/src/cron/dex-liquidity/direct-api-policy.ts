export const DIRECT_API_REQUEST_TIMEOUT_MS = 15_000;
export const DIRECT_API_PROVIDER_TIMEOUT_MS = 90_000;
export const DIRECT_API_FETCH_PHASE_CONCURRENCY = 1;
export const DIRECT_API_DEFAULT_MAX_PAGES = 50;

/**
 * Default per-page byte cap for the paginated direct-API runner.
 *
 * Measured 2026-09-23 against the same public endpoints this phase calls (see
 * `docs/worker-and-api-limits.md#response-body-limits`): Raydium `poolType`
 * pages (1,000 rows) returned 2.0 MB, Meteora (500 rows) 1.0 MB, Balancer's
 * GraphQL list page (246 rows) 182 KB. 8 MiB is ~4x the largest measured page,
 * which keeps a mis-served body (HTML error page, doubled payload) from being
 * buffered and parsed inside the 128 MB isolate without touching legitimate
 * pages. Sources with a tighter measured shape declare their own cap.
 */
export const DIRECT_API_DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;


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
