import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { sleepWithSignal, throwIfAborted } from "./abort";
import {
  cancelResponseBodyQuietly,
  readResponseJsonWithinLimitWithSignal,
  readResponseTextWithSignal,
  readResponseTextWithinLimitWithSignal,
} from "./response-body";
import { redactProviderUrls } from "./safe-error-message";
import { logWorkerEvent } from "./structured-log";

export const DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface FetchWithRetryOptions {
  logUrl?: string;
  passthrough404?: boolean;
  passthroughStatuses?: number[];
  returnFinalResponse?: boolean;
  timeoutMs?: number;
  maxRetryDelayMs?: number;
  /** Applies only when this helper consumes a JSON or text response body. */
  maxResponseBytes?: number;
  waitOnPassthrough429?: boolean;
  /** Retry only thrown transport failures; return the first HTTP response. */
  retryMode?: "default" | "network-only";
  /** Preserve the final thrown transport failure for callers that classify it. */
  throwOnFinalNetworkError?: boolean;
}

export interface FetchWithRetryBodyResult<TResult> {
  response: Response;
  body: TResult;
}

type FetchWithRetryBodyReader<TResult> = (
  response: Response,
  signal: AbortSignal,
  maxResponseBytes: number,
) => Promise<TResult>;

function jitterDelayMs(delayMs: number): number {
  return Math.max(0, Math.round(delayMs * (0.5 + Math.random() * 0.5)));
}

function fetchErrorMetadata(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return {};
  const value = error as { maxBytes?: unknown; observedBytes?: unknown };
  return {
    ...(typeof value.maxBytes === "number" ? { maxBytes: value.maxBytes } : {}),
    ...(typeof value.observedBytes === "number" ? { observedBytes: value.observedBytes } : {}),
  };
}

/**
 * Retry-After wait for a retryable HTTP response: the upstream `Retry-After`
 * header when it is a sane delta-seconds value, otherwise the caller's
 * fallback backoff. Exported so hand-rolled 429 loops (paginated direct-API
 * fetchers) honour `Retry-After` through the same parse as `fetchWithRetry`.
 */
export function resolveRateLimitDelayMs(
  response: Response,
  fallbackDelayMs: number,
  maxRetryDelayMs?: number,
): number {
  const retryAfter = response.headers?.get?.("Retry-After");
  const waitSec = retryAfter ? parseInt(retryAfter, 10) : 0;
  const delayMs = waitSec > 0 && waitSec <= 120 ? waitSec * 1000 : fallbackDelayMs;
  return maxRetryDelayMs != null ? Math.min(delayMs, maxRetryDelayMs) : delayMs;
}

function getRetryDelayMs(response: Response, attempt: number, maxRetryDelayMs?: number): number | null {
  if (response.status === 429) {
    return resolveRateLimitDelayMs(response, 5000, maxRetryDelayMs);
  }
  if (response.status === 408 || (response.status >= 500 && response.status <= 599)) {
    const fallbackDelayMs = response.status === 529
      ? Math.min(30_000, jitterDelayMs(5_000 * 2 ** attempt))
      : jitterDelayMs(1000 * 2 ** attempt);
    return response.status >= 500
      ? resolveRateLimitDelayMs(response, fallbackDelayMs, maxRetryDelayMs)
      : maxRetryDelayMs != null
        ? Math.min(fallbackDelayMs, maxRetryDelayMs)
        : fallbackDelayMs;
  }
  return null;
}
/**
 * Fetch with retry and exponential backoff.
 * Respects Retry-After headers on 429 and 5xx responses.
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
    async (response, signal, maxResponseBytes) =>
      await readResponseJsonWithinLimitWithSignal<TResult>(response, maxResponseBytes, signal),
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
    async (response, signal, maxResponseBytes) =>
      await readResponseTextWithinLimitWithSignal(response, maxResponseBytes, signal),
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
  const maxResponseBytes = readBody
    ? options?.maxResponseBytes ?? DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES
    : DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES;
  if (readBody && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0)) {
    throw new RangeError(`maxResponseBytes must be a non-negative safe integer; received ${maxResponseBytes}`);
  }
  const signal = opts?.signal ?? undefined;
  for (let i = 0; i <= maxRetries; i++) {
    throwIfAborted(signal);
    let responseReceived = false;
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
          body: await readBody(response, perRequestTimeout.signal, maxResponseBytes),
        };
      };
      try {
        const res = await fetch(url, {
          ...opts,
          signal: perRequestTimeout.signal,
        });
        responseReceived = true;
        if (res.ok) return await readFinalResponse(res);
        if (passthroughStatuses.has(res.status)) {
          const passthroughDelayMs = res.status === 429 ? getRetryDelayMs(res, i, maxRetryDelayMs) : null;
          if (passthroughDelayMs != null && options?.waitOnPassthrough429 !== false) {
            if (readBody) {
              const body = await readBody(res, perRequestTimeout.signal, maxResponseBytes);
              perRequestTimeout.dispose();
              logWorkerEvent({ scope: "lib", level: "warn", event: "fetch_retry_passthrough_rate_limited", message: "Fetch rate-limited before passthrough", status: res.status, metadata: { url: logUrl, delayMs: passthroughDelayMs } });
              await sleepWithSignal(passthroughDelayMs, signal);
              return { response: res, body };
            }
            const body = await readResponseTextWithSignal(res, perRequestTimeout.signal);
            perRequestTimeout.dispose();
            logWorkerEvent({ scope: "lib", level: "warn", event: "fetch_retry_passthrough_rate_limited", message: "Fetch rate-limited before passthrough", status: res.status, metadata: { url: logUrl, delayMs: passthroughDelayMs } });
            await sleepWithSignal(passthroughDelayMs, signal);
            return new Response(body, {
              status: res.status,
              statusText: res.statusText,
              headers: res.headers,
            });
          }
          return await readFinalResponse(res);
        }
        if (options?.retryMode === "network-only") {
          return await readFinalResponse(res);
        }
        const retryDelayMs = i < maxRetries ? getRetryDelayMs(res, i, maxRetryDelayMs) : null;
        if (retryDelayMs != null) {
          const label = res.status === 529 ? "overloaded" : res.status === 429 ? "rate-limited" : "server error";
          logWorkerEvent({ scope: "lib", level: "warn", event: "fetch_retry_http_retry_scheduled", message: `Fetch ${label}; retry scheduled`, status: res.status, metadata: { url: logUrl, delayMs: retryDelayMs, attempt: i + 1, maxAttempts: maxRetries + 1 } });
          await cancelResponseBodyQuietly(res);
          perRequestTimeout.dispose();
          await sleepWithSignal(retryDelayMs, signal);
          continue;
        }
        logWorkerEvent({ scope: "lib", level: "warn", event: "fetch_retry_http_error", message: "Fetch returned an HTTP error", status: res.status, metadata: { url: logUrl, attempt: i + 1, maxAttempts: maxRetries + 1 } });
        if (options?.returnFinalResponse) {
          return await readFinalResponse(res);
        }
        await cancelResponseBodyQuietly(res);
        return null;
      } finally {
        perRequestTimeout.dispose();
      }
    } catch (err) {
      if (signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      logWorkerEvent({ scope: "lib", level: "warn", event: "fetch_retry_attempt_failed", message: "Fetch attempt failed", error: err, metadata: { url: logUrl, attempt: i + 1, maxAttempts: maxRetries + 1, ...fetchErrorMetadata(err) } });
      if (
        options?.throwOnFinalNetworkError
        && (i >= maxRetries || (responseReceived && options.retryMode === "network-only"))
      ) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (responseReceived && options?.retryMode === "network-only") return null;
    }
    if (i < maxRetries) {
      await sleepWithSignal(jitterDelayMs(1000 * 2 ** i), signal);
    }
  }
  return null;
}
