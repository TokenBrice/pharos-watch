import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { sleepWithSignal, throwIfAborted } from "./abort";
import { cancelResponseBodyQuietly } from "./response-body";
interface FetchWithRetryOptions {
  passthrough404?: boolean;
  passthroughStatuses?: number[];
  returnFinalResponse?: boolean;
  timeoutMs?: number;
}

function responseWithTimeoutLifetime(response: Response, dispose: () => void): Response {
  if (!response.body) {
    dispose();
    return response;
  }

  const reader = response.body.getReader();
  let disposed = false;
  const disposeOnce = () => {
    if (disposed) return;
    disposed = true;
    dispose();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          disposeOnce();
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      } catch (err) {
        disposeOnce();
        controller.error(err);
      }
    },
    async cancel(reason) {
      disposeOnce();
      await reader.cancel(reason);
    },
  });

  return new Response(body, response);
}

function getRetryDelayMs(response: Response, attempt: number): number | null {
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitSec = retryAfter ? parseInt(retryAfter, 10) : 0;
    return waitSec > 0 && waitSec <= 120 ? waitSec * 1000 : 5000;
  }
  if (response.status === 529) {
    return Math.min(30_000, 5_000 * 2 ** attempt);
  }
  return null;
}
/**
 * Fetch with retry and exponential backoff.
 * Respects Retry-After header on 429 responses.
 * Returns null if all attempts fail.
 *
 * If opts.signal is provided (e.g. from a cron AbortController), it is composed
 * with the per-request timeout via the shared createTimeoutSignal() helper so
 * both fire correctly and the per-attempt timer is always cleared.
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
      const perRequestTimeout = createTimeoutSignal({
        timeoutMs,
        timeoutReason: new DOMException(`fetch timed out after ${timeoutMs}ms`, "TimeoutError"),
        parentSignal: signal,
      });
      const fetched = await fetch(url, {
        ...opts,
        signal: perRequestTimeout.signal,
      });
      const res = responseWithTimeoutLifetime(fetched, perRequestTimeout.dispose);
      if (res.ok) return res;
      if (passthroughStatuses.has(res.status)) {
        const passthroughDelayMs = res.status === 429 ? getRetryDelayMs(res, i) : null;
        if (passthroughDelayMs != null) {
          const body = await res.text();
          console.warn(`[fetch-retry] ${url} rate-limited (${res.status}), waiting ${passthroughDelayMs}ms before passthrough`);
          await sleepWithSignal(passthroughDelayMs, signal);
          return new Response(body, {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
          });
        }
        return res;
      }
      const retryDelayMs = i < maxRetries ? getRetryDelayMs(res, i) : null;
      if (retryDelayMs != null) {
        const label = res.status === 529 ? "overloaded" : "rate-limited";
        console.warn(`[fetch-retry] ${url} ${label} (${res.status}), waiting ${retryDelayMs}ms`);
        await cancelResponseBodyQuietly(res);
        await sleepWithSignal(retryDelayMs, signal);
        continue;
      }
      console.warn(`[fetch-retry] ${url} returned ${res.status} (attempt ${i + 1}/${maxRetries + 1})`);
      if (options?.returnFinalResponse && i >= maxRetries) {
        return res;
      }
      await cancelResponseBodyQuietly(res);
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
