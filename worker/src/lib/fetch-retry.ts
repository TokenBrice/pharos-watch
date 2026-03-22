import { sleepWithSignal, throwIfAborted } from "./abort";

interface FetchWithRetryOptions {
  passthrough404?: boolean;
  passthroughStatuses?: number[];
  timeoutMs?: number;
}

/**
 * Fetch with retry and exponential backoff.
 * Respects Retry-After header on 429 responses.
 * Returns null if all attempts fail.
 *
 * If opts.signal is provided (e.g. from a cron AbortController), it is composed
 * with the per-request timeout via AbortSignal.any() so both fire correctly.
 */
export async function fetchWithRetry(
  url: string,
  opts?: RequestInit,
  maxRetries = 2,
  options?: FetchWithRetryOptions,
): Promise<Response | null> {
  const passthrough404 = options?.passthrough404 ?? false;
  const passthroughStatuses = new Set<number>(options?.passthroughStatuses ?? []);
  if (passthrough404) passthroughStatuses.add(404);
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const signal = opts?.signal ?? undefined;

  for (let i = 0; i <= maxRetries; i++) {
    throwIfAborted(signal);
    try {
      const perRequestTimeout = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, perRequestTimeout])
        : perRequestTimeout;
      const res = await fetch(url, {
        ...opts,
        signal: combinedSignal,
      });
      if (res.ok) return res;
      if (passthroughStatuses.has(res.status)) return res;

      if (res.status === 429 && i < maxRetries) {
        const retryAfter = res.headers.get("Retry-After");
        const waitSec = retryAfter ? parseInt(retryAfter, 10) : 0;
        const waitMs = waitSec > 0 && waitSec <= 120 ? waitSec * 1000 : 5000;
        console.warn(`[fetch-retry] ${url} rate-limited (429), waiting ${waitMs}ms`);
        await res.body?.cancel();
        await sleepWithSignal(waitMs, signal);
        continue;
      }

      console.warn(`[fetch-retry] ${url} returned ${res.status} (attempt ${i + 1}/${maxRetries + 1})`);
      await res.body?.cancel();
    } catch (err) {
      if (signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      console.warn(`[fetch-retry] ${url} failed (attempt ${i + 1}/${maxRetries + 1}):`, err);
    }
    if (i < maxRetries) {
      await sleepWithSignal(1000 * 2 ** i, signal);
    }
  }
  return null;
}
