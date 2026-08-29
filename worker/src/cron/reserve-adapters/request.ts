import {
  fetchTextWithRetry as fetchTextBodyWithRetry,
  fetchWithRetry,
} from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { requireHtmlInput, requireJsonInputFromConfig } from "./input-guards";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";
import { toErrorMessage } from "@shared/lib/error-utils";

export const ADAPTER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export const HTML_ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
export const NEUTRAL_ADAPTER_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
};
const DEFAULT_ADAPTER_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
export const REQUEST_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const REQUEST_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

interface RequestCacheEntry {
  bytes: number;
  promise: Promise<unknown>;
}

interface RequestCacheState {
  entries: Map<string, RequestCacheEntry>;
  totalBytes: number;
}

const requestCacheStates = new WeakMap<Map<string, Promise<unknown>>, RequestCacheState>();

/**
 * Some issuer dashboards gate their JSON/HTML endpoints with CORS-style
 * origin checks. buildBrowserHeaders produces the canonical Origin/Referer
 * /Accept-Language triple adapters pass via `fetchJsonWithRetry`'s options.
 *
 * @param originUrl Fully-qualified origin (e.g. "https://app.ethena.fi"). The
 *   origin is reused as the Referer path root; adapters with a deeper Referer
 *   can pass it via `referer`.
 * @param referer Optional override for the Referer header; defaults to the
 *   origin.
 */
export function buildBrowserHeaders(originUrl: string, referer?: string): HeadersInit {
  return {
    Origin: originUrl,
    Referer: referer ?? originUrl,
    "Accept-Language": "en-US,en;q=0.9",
  };
}

interface JsonRetryOptions {
  headers?: HeadersInit;
  maxResponseBytes?: number;
  maxRetries?: number;
}

interface TextRetryOptions {
  headers?: HeadersInit;
  maxResponseBytes?: number;
  maxRetries?: number;
}

interface AdapterFetchResponse<T> {
  body: T;
  finalUrl: string;
  headers: Headers;
}

function summarizeResponseBody(raw: string, limit = 120): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, limit);
}

function buildJsonParseError(url: string, res: Response, raw: string, error: unknown): Error {
  const contentType = res.headers.get("content-type") ?? "unknown";
  const snippet = summarizeResponseBody(raw);
  const detail = toErrorMessage(error);
  return new Error(
    `JSON parse failed for ${url} (${contentType}): ${detail}${snippet ? `; body starts with: ${snippet}` : ""}`,
  );
}

function getRequestCache(ctx?: AdapterContext): Map<string, Promise<unknown>> | null {
  return ctx?.requestCache ?? null;
}

function getRequestCacheState(cache: Map<string, Promise<unknown>>): RequestCacheState {
  const existing = requestCacheStates.get(cache);
  if (existing) return existing;
  const state: RequestCacheState = { entries: new Map(), totalBytes: 0 };
  requestCacheStates.set(cache, state);
  return state;
}

function removeTrackedRequest(state: RequestCacheState, key: string): void {
  const entry = state.entries.get(key);
  if (!entry) return;
  state.entries.delete(key);
  state.totalBytes = Math.max(0, state.totalBytes - entry.bytes);
}

function reconcileRequestCache(cache: Map<string, Promise<unknown>>, state: RequestCacheState): void {
  for (const [key, entry] of state.entries) {
    if (cache.get(key) !== entry.promise) removeTrackedRequest(state, key);
  }
}

function estimateDecodedByteSize(value: unknown): number {
  if (typeof value === "string") {
    // String length is an acceptable decoded-byte proxy for this cache budget.
    return value.length;
  }
  if (value instanceof Uint8Array) return value.byteLength;
  if (typeof ArrayBuffer !== "undefined" && value instanceof ArrayBuffer) return value.byteLength;
  if (value === null || typeof value !== "object") return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function evictRequestCacheLru(
  cache: Map<string, Promise<unknown>>,
  state: RequestCacheState,
): void {
  while (state.totalBytes > REQUEST_CACHE_MAX_TOTAL_BYTES) {
    const oldest = state.entries.entries().next().value;
    if (!oldest) return;
    const [key, entry] = oldest;
    state.entries.delete(key);
    state.totalBytes = Math.max(0, state.totalBytes - entry.bytes);
    if (cache.get(key) === entry.promise) cache.delete(key);
  }
}

function isHeadersInstance(headers: HeadersInit): headers is Headers {
  return typeof Headers !== "undefined" && headers instanceof Headers;
}

function isPlainHeadersRecord(headers: HeadersInit): headers is Record<string, string> {
  return !Array.isArray(headers) && !isHeadersInstance(headers);
}

function normalizeHeaderEntries(headers: HeadersInit): Array<[string, string]> {
  return Array.from(new Headers(headers).entries()).sort(([leftName, leftValue], [rightName, rightValue]) => {
    if (leftName < rightName) return -1;
    if (leftName > rightName) return 1;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
    return 0;
  });
}

function serializeHeadersForCache(headers?: HeadersInit): string {
  if (!headers) return "null";
  if (isPlainHeadersRecord(headers)) {
    return JSON.stringify(headers);
  }
  return `headers:${JSON.stringify(normalizeHeaderEntries(headers))}`;
}

function serializeRetryOptionsForCache(options?: { maxRetries?: number; maxResponseBytes?: number }): string {
  if (options?.maxRetries == null && options?.maxResponseBytes == null) return "";
  return `:${options?.maxRetries ?? 2}:${options?.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES}`;
}

function fetchBodyOptions(timeoutMs: number, maxResponseBytes?: number) {
  return {
    timeoutMs,
    returnFinalResponse: true as const,
    ...(maxResponseBytes == null ? {} : { maxResponseBytes }),
  };
}

function buildRequestHeaders(
  defaults: Record<string, string>,
  overrides?: HeadersInit,
): HeadersInit {
  if (!overrides || isPlainHeadersRecord(overrides)) {
    return {
      ...defaults,
      ...(overrides ?? {}),
    };
  }

  const merged = new Headers(defaults);
  for (const [name, value] of normalizeHeaderEntries(overrides)) {
    merged.set(name, value);
  }
  return merged;
}

export function getCachedRequest<T>(
  key: string,
  factory: () => Promise<T>,
  ctx?: AdapterContext,
): Promise<T> {
  const cache = getRequestCache(ctx);
  if (!cache) {
    return factory();
  }

  const state = getRequestCacheState(cache);
  reconcileRequestCache(cache, state);
  const cached = cache.get(key) as Promise<T> | undefined;
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    const entry = state.entries.get(key);
    if (entry?.promise === cached) {
      state.entries.delete(key);
      state.entries.set(key, entry);
    }
    return cached;
  }

  const promise: Promise<T> = factory()
    .then((value) => {
      reconcileRequestCache(cache, state);
      if (cache.get(key) !== promise) return value;

      const bytes = estimateDecodedByteSize(value);
      if (bytes > REQUEST_CACHE_MAX_ENTRY_BYTES) {
        cache.delete(key);
        removeTrackedRequest(state, key);
        return value;
      }

      removeTrackedRequest(state, key);
      state.entries.set(key, { bytes, promise });
      state.totalBytes += bytes;
      cache.delete(key);
      cache.set(key, promise);
      evictRequestCacheLru(cache, state);
      return value;
    })
    .catch((error) => {
      if (cache.get(key) === promise) {
        cache.delete(key);
        removeTrackedRequest(state, key);
      }
      throw error;
    });
  cache.set(key, promise);
  return promise;
}

export async function fetchJsonWithRetry<T>(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
  options?: JsonRetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 2;
  return getCachedRequest(
    `json-get:${url}:${timeoutMs}${serializeRetryOptionsForCache(options)}:${serializeHeadersForCache(options?.headers)}`,
    async () => runAdapterIo(ctx, `json-get:${url}`, async () => {
      const result = await fetchTextBodyWithRetry(
        url,
        {
          signal,
          headers: buildRequestHeaders(
            {
              Accept: "application/json",
              "User-Agent": ADAPTER_USER_AGENT,
            },
            options?.headers,
          ),
        },
        maxRetries,
        fetchBodyOptions(timeoutMs, options?.maxResponseBytes),
      );
      if (!result) {
        throw new Error(`Fetch failed for ${url}`);
      }
      if (!result.response.ok) {
        throw new Error(`HTTP ${result.response.status} for ${url}`);
      }
      const raw = result.body;
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        throw buildJsonParseError(url, result.response, raw, error);
      }
    }),
    ctx,
  );
}

export async function fetchJsonPostWithRetry<T>(
  url: string,
  body: unknown,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
  options?: JsonRetryOptions,
): Promise<T> {
  const serializedBody = JSON.stringify(body);
  return getCachedRequest(
    `json-post:${url}:${timeoutMs}:${serializedBody}:${serializeHeadersForCache(options?.headers)}`,
    async () => runAdapterIo(ctx, `json-post:${url}`, async () => {
      const result = await fetchTextBodyWithRetry(
        url,
        {
          method: "POST",
          headers: buildRequestHeaders(
            {
              "Content-Type": "application/json",
              "User-Agent": ADAPTER_USER_AGENT,
            },
            options?.headers,
          ),
          body: serializedBody,
          signal,
        },
        2,
        { timeoutMs, returnFinalResponse: true },
      );
      if (!result) {
        throw new Error(`POST fetch failed for ${url}`);
      }
      if (!result.response.ok) {
        throw new Error(`HTTP ${result.response.status} for POST ${url}`);
      }
      try {
        return JSON.parse(result.body) as T;
      } catch (error) {
        throw buildJsonParseError(url, result.response, result.body, error);
      }
    }),
    ctx,
  );
}

export async function fetchJsonAdapterInput<T>(
  config: LiveReservesConfig,
  adapterName: string,
  signal: AbortSignal,
  timeoutMs = 12_000,
  ctx?: AdapterContext,
  options?: JsonRetryOptions,
): Promise<T> {
  const input = requireJsonInputFromConfig(config, adapterName);
  return fetchJsonWithRetry<T>(input.url, signal, timeoutMs, ctx, options);
}

async function fetchTextResponse(
  url: string,
  signal: AbortSignal,
  timeoutMs: number,
  ctx?: AdapterContext,
  options?: TextRetryOptions,
): Promise<AdapterFetchResponse<string>> {
  const maxRetries = options?.maxRetries ?? 2;
  return runAdapterIo(ctx, `text-get:${url}`, async () => {
    const result = await fetchTextBodyWithRetry(
      url,
      {
        signal,
        headers: buildRequestHeaders(
          {
            "User-Agent": ADAPTER_USER_AGENT,
          },
          options?.headers,
        ),
      },
      maxRetries,
      fetchBodyOptions(timeoutMs, options?.maxResponseBytes),
    );
    if (!result) {
      throw new Error(`Fetch failed for ${url}`);
    }
    if (!result.response.ok) {
      throw new Error(`HTTP ${result.response.status} for ${url}`);
    }
    return {
      body: result.body,
      finalUrl: result.response.url || url,
      headers: result.response.headers,
    };
  });
}

export async function fetchTextResponseWithRetry(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
  options?: TextRetryOptions,
): Promise<AdapterFetchResponse<string>> {
  return getCachedRequest(
    `text-response-get:${url}:${timeoutMs}${serializeRetryOptionsForCache(options)}:${serializeHeadersForCache(options?.headers)}`,
    () => fetchTextResponse(url, signal, timeoutMs, ctx, options),
    ctx,
  );
}

export async function fetchTextWithRetry(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
  options?: TextRetryOptions,
): Promise<string> {
  return getCachedRequest(
    `text-get:${url}:${timeoutMs}${serializeRetryOptionsForCache(options)}:${serializeHeadersForCache(options?.headers)}`,
    async () => (await fetchTextResponse(url, signal, timeoutMs, ctx, options)).body,
    ctx,
  );
}

async function readBinaryBodyWithinLimit(response: Response, url: string, maxBytes: number): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(`maxResponseBytes must be a non-negative safe integer; received ${maxBytes}`);
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength != null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
      throw new Error(`Binary content length is invalid for ${url}`);
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error(`Binary response exceeds ${maxBytes} bytes for ${url}`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Binary response exceeds ${maxBytes} bytes for ${url}`);
    }
    chunks.push(chunk);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function requestHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "unknown-host";
  }
}

/** Fetches a binary body (e.g. an attestation PDF) through the shared retry
 *  and adapter-IO plumbing, so adapters never call the network directly. */
export async function fetchBinaryWithRetry(
  url: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
  ctx?: AdapterContext,
  options?: TextRetryOptions,
): Promise<Uint8Array> {
  return (await fetchBinaryResponseWithRetry(url, signal, timeoutMs, ctx, options)).body;
}

export async function fetchBinaryResponseWithRetry(
  url: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
  ctx?: AdapterContext,
  options?: TextRetryOptions,
): Promise<AdapterFetchResponse<Uint8Array>> {
  const maxRetries = options?.maxRetries ?? 2;
  const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES;
  return runAdapterIo(ctx, `binary-get:${url}`, async () => {
    const response = await fetchWithRetry(
      url,
      {
        signal,
        headers: buildRequestHeaders({ "User-Agent": ADAPTER_USER_AGENT }, options?.headers),
      },
      maxRetries,
      { timeoutMs, returnFinalResponse: true },
    );
    if (!response?.ok) {
      await cancelResponseBodyQuietly(response);
      const host = requestHost(url);
      throw new Error(response ? `HTTP ${response.status} for ${host}` : `Fetch failed for ${host}`);
    }
    return {
      body: await readBinaryBodyWithinLimit(response, url, maxResponseBytes),
      finalUrl: response.url || url,
      headers: response.headers,
    };
  });
}

export async function fetchPrimaryHtmlInput(
  config: LiveReservesConfig,
  adapterName: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  timeoutMs = 15_000,
  options?: TextRetryOptions,
): Promise<string> {
  const input = requireHtmlInput(config.inputs.primary, adapterName);
  return fetchTextWithRetry(input.url, signal, timeoutMs, ctx, options);
}
