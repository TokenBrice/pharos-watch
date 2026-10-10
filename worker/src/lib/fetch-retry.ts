import { createTimeoutSignal } from "@shared/lib/timeout-signal";
import { parseRetryAfterSeconds } from "@shared/lib/retry-after";
import { FetchRequestNotStartedError, sleepWithSignal, throwIfAborted } from "./abort";
import {
  cancelResponseBodyQuietly,
  readResponseBytesWithinLimitWithSignal,
  readResponseJsonWithinLimitWithSignal,
  readResponseTextWithinLimitWithSignal,
} from "./response-body";
import type { BodyReadObserver } from "./response-body";
import { redactProviderUrls } from "./safe-error-message";
import { logWorkerEvent } from "./structured-log";
import type { z } from "zod";

export const DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

interface FetchWithRetryOptions {
  logUrl?: string;
  /** Observes each received HTTP response before body handling or retry. */
  onResponse?: (response: Response) => void;
  /** Actual body intake per attempt, before decoding; includes rejected reads. */
  onBodyRead?: BodyReadObserver;
  passthrough404?: boolean;
  passthroughStatuses?: number[];
  returnFinalResponse?: boolean;
  timeoutMs?: number;
  /** Absolute deadline for admission, response intake, and retry backoff. */
  deadlineMs?: number;
  /** Runs before every physical request, including retries; false denies admission. */
  beforeRequest?: () => boolean;
  maxRetryDelayMs?: number;
  /** Applies only when this helper consumes a JSON, text, or binary response body. */
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

export interface FetchJsonSchemaFailure {
  kind: "schema-validation";
  message: string;
}

export type FetchJsonWithSchemaResult<TResult> =
  | {
    success: true;
    response: Response;
    body: TResult;
  }
  | {
    success: false;
    response: Response;
    failure: FetchJsonSchemaFailure;
  };

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
  const waitSec = parseRetryAfterSeconds(response.headers?.get?.("Retry-After"), {
    allowNumericPrefix: true,
    numericRounding: "floor",
  }) ?? 0;
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
 * Throws FetchRequestNotStartedError when admission or the deadline prevents
 * a physical request; attemptsStarted distinguishes an untried URL from a
 * denied retry after genuine failed attempts.
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
      await readResponseJsonWithinLimitWithSignal<TResult>(response, maxResponseBytes, signal, options?.onBodyRead),
  );
}

export async function fetchJsonWithSchema<TSchema extends z.ZodType>(
  url: string,
  schema: TSchema,
  opts?: RequestInit,
  maxRetries = 2,
  options?: FetchWithRetryOptions,
): Promise<FetchJsonWithSchemaResult<z.infer<TSchema>> | null> {
  const result = await fetchJsonWithRetry<unknown>(url, opts, maxRetries, options);
  if (!result) return null;
  const parsed = schema.safeParse(result.body);
  if (!parsed.success) {
    return {
      success: false,
      response: result.response,
      failure: {
        kind: "schema-validation",
        message: parsed.error.message,
      },
    };
  }
  return {
    success: true,
    response: result.response,
    body: parsed.data,
  };
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
      await readResponseTextWithinLimitWithSignal(response, maxResponseBytes, signal, options?.onBodyRead),
  );
}

/**
 * Fetch a binary body with retry and exponential backoff, reading the body
 * inside the per-attempt timeout lifecycle. Binary bodies of unsuccessful
 * final responses are cancelled (never read) and reported as empty bytes, so
 * the caller still receives the response status while the connection returns
 * to the pool immediately.
 */
export async function fetchBinaryWithRetry(
  url: string,
  opts?: RequestInit,
  maxRetries = 2,
  options?: FetchWithRetryOptions,
): Promise<FetchWithRetryBodyResult<Uint8Array> | null> {
  return await fetchWithRetryInternal<Uint8Array>(
    url,
    opts,
    maxRetries,
    options,
    async (response, signal, maxResponseBytes) => {
      if (!response.ok) {
        await cancelResponseBodyQuietly(response);
        return new Uint8Array(0);
      }
      return await readResponseBytesWithinLimitWithSignal(response, maxResponseBytes, signal, options?.onBodyRead);
    },
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
  const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES;
  if (readBody && (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0)) {
    throw new RangeError(`maxResponseBytes must be a non-negative safe integer; received ${maxResponseBytes}`);
  }
  const signal = opts?.signal ?? undefined;
  let attemptsStarted = 0;
  for (let i = 0; i <= maxRetries; i++) {
    throwIfAborted(signal);
    const remainingMs = options?.deadlineMs == null ? timeoutMs : options.deadlineMs - Date.now();
    if (remainingMs <= 0) throw new FetchRequestNotStartedError("deadline-exceeded", attemptsStarted);
    if (options?.beforeRequest?.() === false) throw new FetchRequestNotStartedError("admission-denied", attemptsStarted);
    const attemptTimeoutMs = Math.min(timeoutMs, remainingMs);
    let responseReceived = false;
    try {
      const perRequestTimeout = createTimeoutSignal({
        timeoutMs: attemptTimeoutMs,
        timeoutReason: new DOMException(`fetch timed out after ${attemptTimeoutMs}ms`, "TimeoutError"),
        parentSignal: signal,
      });
      const readFinalResponse = async (response: Response): Promise<Response | FetchWithRetryBodyResult<TResult>> => {
        if (!readBody) return response;
        const body = await readBody(response, perRequestTimeout.signal, maxResponseBytes);
        if (options?.deadlineMs != null && Date.now() >= options.deadlineMs) {
          throw new DOMException("fetch deadline exceeded", "TimeoutError");
        }
        return { response, body };
      };
      try {
        attemptsStarted += 1;
        const res = await fetch(url, {
          ...opts,
          signal: perRequestTimeout.signal,
        });
        responseReceived = true;
        options?.onResponse?.(res);
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
            const body = await readResponseTextWithinLimitWithSignal(res, maxResponseBytes, perRequestTimeout.signal, options?.onBodyRead);
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
      const delayMs = jitterDelayMs(1000 * 2 ** i);
      await sleepWithSignal(options?.deadlineMs == null ? delayMs : Math.max(0, Math.min(delayMs, options.deadlineMs - Date.now())), signal);
    }
  }
  return null;
}
