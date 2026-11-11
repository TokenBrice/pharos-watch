import { fetchTextWithRetry as fetchTextBodyWithRetry } from "./fetch-retry";
import type { BodyReadObserver } from "./response-body";
import { redactProviderUrls } from "./safe-error-message";

export const ADAPTER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export interface JsonRetryOptions {
  headers?: HeadersInit;
  maxResponseBytes?: number;
  maxRetries?: number;
  /** Observes every actual response, including retries; bypasses caching/coalescing. */
  onResponse?: (response: Response) => void;
  redirect?: RequestInit["redirect"];
}


export interface JsonRequestExecutor {
  get<T>(url: string, signal: AbortSignal, timeoutMs: number, options?: JsonRetryOptions): Promise<T>;
  post<T>(url: string, body: unknown, signal: AbortSignal, timeoutMs: number, options?: JsonRetryOptions): Promise<T>;
}

function buildJsonParseError(url: string, res: Response, error: unknown): Error {
  const contentType = res.headers.get("content-type") ?? "unknown";
  // This message is persisted as the public reserve `sync.lastError`, so it may
  // name transport identity (status, content type, redacted URL) but never
  // upstream body text. V8's JSON.parse message quotes the body, so only the
  // error class is kept.
  const reason = error instanceof Error && /^[A-Za-z]+$/.test(error.name) ? error.name : "Error";
  const finalUrl = res.url && res.url !== url ? `; final URL ${redactProviderUrls(res.url)}` : "";
  return new Error(
    `JSON parse failed for ${redactProviderUrls(url)} (HTTP ${res.status}, ${contentType}${finalUrl}): ${reason}`,
  );
}

function isHeadersInstance(headers: HeadersInit): headers is Headers {
  return typeof Headers !== "undefined" && headers instanceof Headers;
}

export function fetchBodyOptions(
  timeoutMs: number,
  maxResponseBytes?: number,
  validateResponse?: (response: Response) => void,
) {
  return {
    timeoutMs,
    returnFinalResponse: true as const,
    throwOnFinalNetworkError: true as const,
    ...(maxResponseBytes == null ? {} : { maxResponseBytes }),
    ...(validateResponse == null ? {} : { validateResponse }),
  };
}

export function buildRequestHeaders(
  defaults: Record<string, string>,
  overrides?: HeadersInit,
): Headers {
  const merged = new Headers(defaults);
  if (overrides) {
    for (const [name, value] of isHeadersInstance(overrides) ? overrides : new Headers(overrides)) {
      merged.set(name, value);
    }
  }
  return merged;
}


export function prepareJsonGet(url: string, signal: AbortSignal, timeoutMs: number, options?: JsonRetryOptions) {
  const maxRetries = options?.maxRetries ?? 2;
  const headers = buildRequestHeaders(
    { Accept: "application/json", "User-Agent": ADAPTER_USER_AGENT }, options?.headers,
  );
  const redirect = options?.redirect ?? "follow";
  return {
    headers, redirect,
    async execute<T>(onBodyRead: BodyReadObserver): Promise<T> {
      const result = await fetchTextBodyWithRetry(url, { signal, redirect, headers }, maxRetries,
        { ...fetchBodyOptions(timeoutMs, options?.maxResponseBytes), onResponse: options?.onResponse, onBodyRead });
      if (!result) throw new Error(`Fetch failed for ${redactProviderUrls(url)}`);
      if (!result.response.ok) throw new Error(`HTTP ${result.response.status} for ${redactProviderUrls(url)}`);
      try {
        return JSON.parse(result.body) as T;
      } catch (error) {
        throw buildJsonParseError(url, result.response, error);
      }
    },
  };
}

export function prepareJsonPost(url: string, body: unknown, signal: AbortSignal, timeoutMs: number, options?: JsonRetryOptions) {
  const serializedBody = JSON.stringify(body);
  const maxRetries = options?.maxRetries ?? 2;
  const headers = buildRequestHeaders(
    { "Content-Type": "application/json", "User-Agent": ADAPTER_USER_AGENT }, options?.headers,
  );
  const redirect = options?.redirect ?? "follow";
  return {
    headers, redirect, serializedBody,
    async execute<T>(onBodyRead: BodyReadObserver): Promise<T> {
      const result = await fetchTextBodyWithRetry(url, { redirect, method: "POST", headers, body: serializedBody, signal }, maxRetries,
        { ...fetchBodyOptions(timeoutMs, options?.maxResponseBytes), onResponse: options?.onResponse, onBodyRead });
      if (!result) throw new Error(`POST fetch failed for ${redactProviderUrls(url)}`);
      if (!result.response.ok) throw new Error(`HTTP ${result.response.status} for POST ${redactProviderUrls(url)}`);
      try {
        return JSON.parse(result.body) as T;
      } catch (error) {
        throw buildJsonParseError(url, result.response, error);
      }
    },
  };
}

export const jsonRequestExecutor: JsonRequestExecutor = {
  get: <T>(url: string, signal: AbortSignal, timeoutMs: number, options?: JsonRetryOptions) => prepareJsonGet(url, signal, timeoutMs, options).execute<T>(() => {}),
  post: <T>(url: string, body: unknown, signal: AbortSignal, timeoutMs: number, options?: JsonRetryOptions) => prepareJsonPost(url, body, signal, timeoutMs, options).execute<T>(() => {}),
};

export async function fetchJsonWithRetry<T>(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  _ctx?: undefined,
  options?: JsonRetryOptions,
): Promise<T> {
  return jsonRequestExecutor.get<T>(url, signal, timeoutMs, options);
}

export async function fetchJsonPostWithRetry<T>(
  url: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = 10_000,
  _ctx?: undefined,
  options?: JsonRetryOptions,
): Promise<T> {
  return jsonRequestExecutor.post<T>(url, body, signal, timeoutMs, options);
}
