import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { sleepWithSignal, throwIfAborted } from "./abort";
import {
  cancelResponseBodyQuietly,
  readResponseJsonWithSignal,
  readResponseTextWithSignal,
} from "./response-body";
import { redactProviderUrls } from "./safe-error-message";
interface FetchWithRetryOptions {
  logUrl?: string;
  passthrough404?: boolean;
  passthroughStatuses?: number[];
  returnFinalResponse?: boolean;
  timeoutMs?: number;
  maxRetryDelayMs?: number;
  waitOnPassthrough429?: boolean;
}

export interface FetchWithRetryBodyResult<TResult> {
  response: Response;
  body: TResult;
}

type FetchWithRetryBodyReader<TResult> = (response: Response, signal: AbortSignal) => Promise<TResult>;

function jitterDelayMs(delayMs: number): number {
  return Math.max(0, Math.round(delayMs * (0.5 + Math.random() * 0.5)));
}

function getRetryDelayMs(response: Response, attempt: number, maxRetryDelayMs?: number): number | null {
  if (response.status === 429) {
    const retryAfter = response.headers.get("Retry-After");
    const waitSec = retryAfter ? parseInt(retryAfter, 10) : 0;
    const delayMs = waitSec > 0 && waitSec <= 120 ? waitSec * 1000 : 5000;
    return maxRetryDelayMs != null ? Math.min(delayMs, maxRetryDelayMs) : delayMs;
  }
  if (response.status === 529) {
    const delayMs = Math.min(30_000, jitterDelayMs(5_000 * 2 ** attempt));
    return maxRetryDelayMs != null ? Math.min(delayMs, maxRetryDelayMs) : delayMs;
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
  return await fetchWithRetryInternal(url, opts, maxRetries, options);
}

export async function fetchJsonWithRetry<TResult = unknown>(
  url: string,
  opts?: RequestInit,
  maxRetries = 2,
  options?: FetchWithRetryOptions,
): Promise<FetchWithRetryBodyResult<TResult> | null> {
  return await fetchWithRetryInternal<TResult>(
    url,
    opts,
    maxRetries,
    options,
    async (response, signal) => await readResponseJsonWithSignal<TResult>(response, signal),
  );
}

export async function fetchTextWithRetry(
  url: string,
  opts?: RequestInit,
  maxRetries = 2,
  options?: FetchWithRetryOptions,
): Promise<FetchWithRetryBodyResult<string> | null> {
  return await fetchWithRetryInternal<string>(
    url,
    opts,
    maxRetries,
    options,
    async (response, signal) => await readResponseTextWithSignal(response, signal),
  );
}

async function fetchWithRetryInternal(
  url: string,
  opts: RequestInit | undefined,
  maxRetries: number,
  options: FetchWithRetryOptions | undefined,
): Promise<Response | null>;
async function fetchWithRetryInternal<TResult>(
  url: string,
  opts: RequestInit | undefined,
  maxRetries: number,
  options: FetchWithRetryOptions | undefined,
  readBody: FetchWithRetryBodyReader<TResult>,
): Promise<FetchWithRetryBodyResult<TResult> | null>;
async function fetchWithRetryInternal<TResult>(
  url: string,
  opts: RequestInit | undefined,
  maxRetries: number,
  options: FetchWithRetryOptions | undefined,
  readBody?: FetchWithRetryBodyReader<TResult>,
): Promise<Response | FetchWithRetryBodyResult<TResult> | null> {
  const logUrl = options?.logUrl ?? redactProviderUrls(url);
  const passthrough404 = options?.passthrough404 ?? false;
  const passthroughStatuses = new Set<number>(options?.passthroughStatuses ?? []);
  if (passthrough404) passthroughStatuses.add(404);
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const maxRetryDelayMs = options?.maxRetryDelayMs;
  const signal = opts?.signal ?? undefined;
  for (let i = 0; i <= maxRetries; i++) {
    throwIfAborted(signal);
    try {
      const perRequestTimeout = createTimeoutSignal({
        timeoutMs,
        timeoutReason: new DOMException(`fetch timed out after ${timeoutMs}ms`, "TimeoutError"),
        parentSignal: signal,
      });
      const readFinalResponse = async (response: Response): Promise<Response | FetchWithRetryBodyResult<TResult>> => {
        if (!readBody) return response;
        return {
          response,
          body: await readBody(response, perRequestTimeout.signal),
        };
      };
      try {
        const res = await fetch(url, {
          ...opts,
          signal: perRequestTimeout.signal,
        });
        if (res.ok) return await readFinalResponse(res);
        if (passthroughStatuses.has(res.status)) {
          const passthroughDelayMs = res.status === 429 ? getRetryDelayMs(res, i, maxRetryDelayMs) : null;
          if (passthroughDelayMs != null && options?.waitOnPassthrough429 !== false) {
            if (readBody) {
              const body = await readBody(res, perRequestTimeout.signal);
              perRequestTimeout.dispose();
              console.warn(`[fetch-retry] ${logUrl} rate-limited (${res.status}), waiting ${passthroughDelayMs}ms before passthrough`);
              await sleepWithSignal(passthroughDelayMs, signal);
              return { response: res, body };
            }
            const body = await readResponseTextWithSignal(res, perRequestTimeout.signal);
            perRequestTimeout.dispose();
            console.warn(`[fetch-retry] ${logUrl} rate-limited (${res.status}), waiting ${passthroughDelayMs}ms before passthrough`);
            await sleepWithSignal(passthroughDelayMs, signal);
            return new Response(body, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          }
          return await readFinalResponse(res);
        }
        const retryDelayMs = i < maxRetries ? getRetryDelayMs(res, i, maxRetryDelayMs) : null;
        if (retryDelayMs != null) {
          const label = res.status === 529 ? "overloaded" : "rate-limited";
          console.warn(`[fetch-retry] ${logUrl} ${label} (${res.status}), waiting ${retryDelayMs}ms`);
          await cancelResponseBodyQuietly(res);
          perRequestTimeout.dispose();
          await sleepWithSignal(retryDelayMs, signal);
          continue;
        }
        console.warn(`[fetch-retry] ${logUrl} returned ${res.status} (attempt ${i + 1}/${maxRetries + 1})`);
        if (options?.returnFinalResponse && i >= maxRetries) {
          return await readFinalResponse(res);
        }
        await cancelResponseBodyQuietly(res);
      } finally {
        perRequestTimeout.dispose();
      }
    } catch (err) {
      if (signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      console.warn(`[fetch-retry] ${logUrl} failed (attempt ${i + 1}/${maxRetries + 1}):`, err);
    }
    if (i < maxRetries) {
      await sleepWithSignal(jitterDelayMs(1000 * 2 ** i), signal);
    }
  }
  return null;
}
