export const DIRECT_API_REQUEST_TIMEOUT_MS = 15_000;
export const DIRECT_API_PROVIDER_TIMEOUT_MS = 90_000;
export const DIRECT_API_FETCH_PHASE_CONCURRENCY = 1;
export const DIRECT_API_DEFAULT_MAX_PAGES = 50;

export function buildDirectApiRequestSignal(
  signal?: AbortSignal,
  timeoutMs = DIRECT_API_REQUEST_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
