import {
  fetchBinaryWithRetry as fetchBinaryBodyWithRetry,
  fetchTextWithRetry as fetchTextBodyWithRetry,
  DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES,
} from "../../lib/fetch-retry";
import { USER_AGENT } from "../../lib/constants";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import type { BodyReadObserver } from "../../lib/response-body";
import { buildResourcePressure } from "../../lib/cron-resource-pressure";
import type { ResourcePressure } from "@shared/types/status/cron";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { requireHtmlInput, requireJsonInputFromConfig } from "./input-guards";
import type { AdapterContext } from "./types";
import { RESERVE_ADAPTER_MAX_PARALLEL_IO, runAdapterIo } from "./concurrency";
import { toErrorMessage } from "@shared/lib/error-utils";
import { redactProviderUrls } from "../../lib/safe-error-message";

export const ADAPTER_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
export const HTML_ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
export const NEUTRAL_ADAPTER_HEADERS = {
  "User-Agent": USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
};
const DEFAULT_ADAPTER_MAX_RESPONSE_BYTES = DEFAULT_FETCH_RETRY_MAX_RESPONSE_BYTES;
export const REQUEST_CACHE_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const REQUEST_CACHE_MAX_ENTRY_BYTES = 4 * 1024 * 1024;

export interface CachedRequestValue<T> {
  value: T;
  cacheBytes: number | null;
  basis: ResourcePressure["cacheBasis"];
}

interface RequestCacheEntry {
  bytes: number;
  promise: Promise<unknown>;
  basis: ResourcePressure["cacheBasis"];
}

interface RequestCacheState {
  entries: Map<string, RequestCacheEntry>;
  pending: Map<string, Promise<unknown>>;
  totalBytes: number;
  intakeBytes: number | null;
  rejectedBodies: number;
  bodyCapBytes: number | null;
  cacheBypassed: boolean;
}

const requestCacheStates = new WeakMap<object, RequestCacheState>();

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

export async function fetchWithBrowserFallback<T>(
  origin: string,
  referer: string,
  fetcher: (headers: HeadersInit) => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await fetcher(buildBrowserHeaders(origin, referer));
  } catch (primaryError) {
    if (signal.aborted) throw primaryError;
    try {
      return await fetcher(NEUTRAL_ADAPTER_HEADERS);
    } catch (fallbackError) {
      if (signal.aborted) throw fallbackError;
      throw new Error(
        `browser fetch failed: ${toErrorMessage(primaryError)}; neutral fetch failed: ${toErrorMessage(fallbackError)}`,
      );
    }
  }
}

interface JsonRetryOptions {
  headers?: HeadersInit;
  maxResponseBytes?: number;
  maxRetries?: number;
  /** Observes every actual response, including retries; bypasses caching/coalescing. */
  onResponse?: (response: Response) => void;
  redirect?: RequestInit["redirect"];
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
  const finalUrl = res.url && res.url !== url ? `; final URL ${redactProviderUrls(res.url)}` : "";
  return new Error(
    `JSON parse failed for ${redactProviderUrls(url)} (HTTP ${res.status}, ${contentType}${finalUrl}): ${detail}${snippet ? `; body starts with: ${snippet}` : ""}`,
  );
}

function getRequestCache(ctx?: AdapterContext): Map<string, Promise<unknown>> | null {
  return ctx?.requestCache ?? null;
}

function getRequestCacheState(key: object): RequestCacheState {
  const existing = requestCacheStates.get(key);
  if (existing) return existing;
  const state: RequestCacheState = {
    entries: new Map(), pending: new Map(), totalBytes: 0, intakeBytes: 0,
    rejectedBodies: 0, bodyCapBytes: null, cacheBypassed: false,
  };
  requestCacheStates.set(key, state);
  return state;
}

/** The last attempt's intake sizes retention; all attempts contribute to run intake. */
export function createRequestBodyObserver(ctx: AdapterContext | undefined, maxBytes: number) {
  const state = ctx ? getRequestCacheState(ctx.requestCache ?? ctx) : null;
  if (state) state.bodyCapBytes = Math.max(state.bodyCapBytes ?? 0, maxBytes);
  const observation: { intakeBytes: number | null; onBodyRead: BodyReadObserver } = {
    intakeBytes: null,
    onBodyRead(evidence) {
      observation.intakeBytes = evidence.intakeBytes;
      if (!state) return;
      state.intakeBytes = state.intakeBytes == null || evidence.intakeBytes == null
        ? null : state.intakeBytes + evidence.intakeBytes;
      // Transport interruption is not evidence that the byte budget was exceeded.
      if (evidence.outcome === "rejected"
        && ((evidence.intakeBytes ?? 0) > maxBytes || (evidence.declaredBytes ?? 0) > maxBytes)) {
        state.rejectedBodies++;
      }
    },
  };
  return observation;
}

export function getRequestResourceSnapshot(ctx: AdapterContext, phase: string): ResourcePressure {
  const state = getRequestCacheState(ctx.requestCache ?? ctx);
  if (ctx.requestCache) reconcileRequestCache(ctx.requestCache, state);
  const bases = new Set([...state.entries.values()].map((entry) => entry.basis));
  return buildResourcePressure({
    phase,
    bodyCapBytes: state.bodyCapBytes,
    cacheCapBytes: ctx.requestCache ? REQUEST_CACHE_MAX_TOTAL_BYTES : null,
    cacheEntryCapBytes: ctx.requestCache ? REQUEST_CACHE_MAX_ENTRY_BYTES : null,
    maxConcurrentDecodes: ctx.ioLimiter ? RESERVE_ADAPTER_MAX_PARALLEL_IO : null,
    intakeBytes: state.bodyCapBytes == null ? null : state.intakeBytes,
    cacheBytes: ctx.requestCache ? state.totalBytes : null,
    rejectedBodies: state.bodyCapBytes == null ? null : state.rejectedBodies,
    cacheBasis: bases.size > 1 ? "mixed" : bases.values().next().value ?? "unavailable",
    cacheBypassed: state.cacheBypassed,
  });
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


function evictRequestCacheLru(
  cache: Map<string, Promise<unknown>>,
  state: RequestCacheState,
  incomingBytes: number,
): void {
  while (state.totalBytes + incomingBytes > REQUEST_CACHE_MAX_TOTAL_BYTES) {
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

function serializeHeadersForCache(headers: Headers): string {
  return JSON.stringify(Array.from(headers.entries()).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0));
}

function serializeRetryOptionsForCache(options?: { maxRetries?: number; maxResponseBytes?: number }): string {
  if (options?.maxRetries == null && options?.maxResponseBytes == null) return "";
  return `:${options?.maxRetries ?? 2}:${options?.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES}`;
}

function fetchBodyOptions(timeoutMs: number, maxResponseBytes?: number) {
  return {
    timeoutMs,
    returnFinalResponse: true as const,
    throwOnFinalNetworkError: true as const,
    ...(maxResponseBytes == null ? {} : { maxResponseBytes }),
  };
}

function buildRequestHeaders(
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

export function getCachedRequest<T>(
  key: string,
  factory: () => Promise<CachedRequestValue<T>>,
  ctx?: AdapterContext,
): Promise<T> {
  const cache = getRequestCache(ctx);
  if (!cache) return factory().then(({ value }) => value);
  const state = getRequestCacheState(cache);
  reconcileRequestCache(cache, state);
  const cached = state.pending.get(key) ?? cache.get(key);
  if (cached) {
    const entry = state.entries.get(key);
    if (entry) {
      state.entries.delete(key);
      state.entries.set(key, entry);
    }
    ctx?.onRequestCache?.({ key, hit: true, promise: cached });
    return cached as Promise<T>;
  }

  const promise: Promise<T> = Promise.resolve().then(factory).then(({ value, cacheBytes, basis }) => {
    reconcileRequestCache(cache, state);
    if (cacheBytes == null || !Number.isSafeInteger(cacheBytes) || cacheBytes < 0
      || cacheBytes > REQUEST_CACHE_MAX_ENTRY_BYTES || basis === "unavailable") {
      state.cacheBypassed = true;
      return value;
    }
    // Evict before admission: retained entries never transiently exceed the policy.
    evictRequestCacheLru(cache, state, cacheBytes);
    state.entries.set(key, { bytes: cacheBytes, promise, basis });
    state.totalBytes += cacheBytes;
    cache.set(key, promise);
    return value;
  }).finally(() => {
    if (state.pending.get(key) === promise) state.pending.delete(key);
  });
  state.pending.set(key, promise);
  ctx?.onRequestCache?.({ key, hit: false, promise });
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
  const headers = buildRequestHeaders(
    { Accept: "application/json", "User-Agent": ADAPTER_USER_AGENT }, options?.headers,
  );
  const redirect = options?.redirect ?? "follow";
  const factory = async (): Promise<CachedRequestValue<T>> => runAdapterIo(ctx, `json-get:${url}`, async () => {
    const observation = createRequestBodyObserver(ctx, options?.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES);
    const result = await fetchTextBodyWithRetry(
      url,
      {
        signal,
        redirect,
        headers,
      },
      maxRetries,
      { ...fetchBodyOptions(timeoutMs, options?.maxResponseBytes), onResponse: options?.onResponse, onBodyRead: observation.onBodyRead },
    );
    if (!result) {
      throw new Error(`Fetch failed for ${url}`);
    }
    if (!result.response.ok) {
      throw new Error(`HTTP ${result.response.status} for ${url}`);
    }
    const raw = result.body;
    try {
      return { value: JSON.parse(raw) as T, cacheBytes: observation.intakeBytes == null ? null : 8 * observation.intakeBytes, basis: "intake-estimate" };
    } catch (error) {
      throw buildJsonParseError(url, result.response, raw, error);
    }
  });
  if (options?.onResponse) {
    if (ctx?.requestCache) getRequestCacheState(ctx.requestCache).cacheBypassed = true;
    return (await factory()).value;
  }
  return getCachedRequest(
    `json-get:${url}:${timeoutMs}${serializeRetryOptionsForCache(options)}:${redirect}:${serializeHeadersForCache(headers)}`,
    factory,
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
  const maxRetries = options?.maxRetries ?? 2;
  const headers = buildRequestHeaders(
    { "Content-Type": "application/json", "User-Agent": ADAPTER_USER_AGENT }, options?.headers,
  );
  const redirect = options?.redirect ?? "follow";
  const factory = async (): Promise<CachedRequestValue<T>> => runAdapterIo(ctx, `json-post:${url}`, async () => {
    const observation = createRequestBodyObserver(ctx, options?.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES);
    const result = await fetchTextBodyWithRetry(
      url,
      {
        redirect,
        method: "POST",
        headers,
        body: serializedBody,
        signal,
      },
      maxRetries,
      { ...fetchBodyOptions(timeoutMs, options?.maxResponseBytes), onResponse: options?.onResponse, onBodyRead: observation.onBodyRead },
    );
    if (!result) {
      throw new Error(`POST fetch failed for ${url}`);
    }
    if (!result.response.ok) {
      throw new Error(`HTTP ${result.response.status} for POST ${url}`);
    }
    try {
      return { value: JSON.parse(result.body) as T, cacheBytes: observation.intakeBytes == null ? null : 8 * observation.intakeBytes, basis: "intake-estimate" };
    } catch (error) {
      throw buildJsonParseError(url, result.response, result.body, error);
    }
  });
  if (options?.onResponse) {
    if (ctx?.requestCache) getRequestCacheState(ctx.requestCache).cacheBypassed = true;
    return (await factory()).value;
  }
  return getCachedRequest(
    `json-post:${url}:${timeoutMs}:${serializedBody}${serializeRetryOptionsForCache(options)}:${redirect}:${serializeHeadersForCache(headers)}`,
    factory,
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
  headers: Headers,
  ctx?: AdapterContext,
  options?: TextRetryOptions,
): Promise<CachedRequestValue<AdapterFetchResponse<string>>> {
  const maxRetries = options?.maxRetries ?? 2;
  return runAdapterIo(ctx, `text-get:${url}`, async () => {
    const observation = createRequestBodyObserver(ctx, options?.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES);
    const result = await fetchTextBodyWithRetry(
      url,
      {
        signal,
        headers,
      },
      maxRetries,
      { ...fetchBodyOptions(timeoutMs, options?.maxResponseBytes), onBodyRead: observation.onBodyRead },
    );
    if (!result) {
      throw new Error(`Fetch failed for ${url}`);
    }
    if (!result.response.ok) {
      throw new Error(`HTTP ${result.response.status} for ${url}`);
    }
    return {
      value: { body: result.body, finalUrl: result.response.url || url, headers: result.response.headers },
      cacheBytes: observation.intakeBytes == null ? null : Math.max(observation.intakeBytes, 2 * result.body.length) + 512,
      basis: "intake-estimate",
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
  const headers = buildRequestHeaders({ "User-Agent": ADAPTER_USER_AGENT }, options?.headers);
  return getCachedRequest(
    `text-response-get:${url}:${timeoutMs}${serializeRetryOptionsForCache(options)}:${serializeHeadersForCache(headers)}`,
    () => fetchTextResponse(url, signal, timeoutMs, headers, ctx, options),
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
  const headers = buildRequestHeaders({ "User-Agent": ADAPTER_USER_AGENT }, options?.headers);
  return getCachedRequest(
    `text-get:${url}:${timeoutMs}${serializeRetryOptionsForCache(options)}:${serializeHeadersForCache(headers)}`,
    async () => {
      const response = await fetchTextResponse(url, signal, timeoutMs, headers, ctx, options);
      return { value: response.value.body, cacheBytes: response.cacheBytes == null ? null : response.cacheBytes - 512, basis: response.basis };
    },
    ctx,
  );
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
    const observation = createRequestBodyObserver(ctx, maxResponseBytes);
    const result = await fetchBinaryBodyWithRetry(
      url,
      {
        signal,
        headers: buildRequestHeaders({ "User-Agent": ADAPTER_USER_AGENT }, options?.headers),
      },
      maxRetries,
      { ...fetchBodyOptions(timeoutMs, maxResponseBytes), onBodyRead: observation.onBodyRead },
    );
    if (!result) {
      throw new Error(`Fetch failed for ${requestHost(url)}`);
    }
    if (!result.response.ok) {
      await cancelResponseBodyQuietly(result.response);
      throw new Error(`HTTP ${result.response.status} for ${requestHost(url)}`);
    }
    return {
      body: result.body,
      finalUrl: result.response.url || url,
      headers: result.response.headers,
    };
  });
}

/** Posts a binary body (e.g. a CBOR-encoded IC query) and returns the binary
 *  response through the shared retry and adapter-IO plumbing. Not cached: the
 *  caller owns request identity for non-JSON bodies. */
export async function fetchBinaryPostWithRetry(
  url: string,
  body: Uint8Array,
  contentType: string,
  signal: AbortSignal,
  timeoutMs = 15_000,
  ctx?: AdapterContext,
  options?: TextRetryOptions,
): Promise<Uint8Array> {
  const maxRetries = options?.maxRetries ?? 1;
  const maxResponseBytes = options?.maxResponseBytes ?? DEFAULT_ADAPTER_MAX_RESPONSE_BYTES;
  return runAdapterIo(ctx, `binary-post:${url}`, async () => {
    const observation = createRequestBodyObserver(ctx, maxResponseBytes);
    const result = await fetchBinaryBodyWithRetry(
      url,
      {
        method: "POST",
        headers: buildRequestHeaders(
          { "Content-Type": contentType, "User-Agent": ADAPTER_USER_AGENT },
          options?.headers,
        ),
        body,
        signal,
      },
      maxRetries,
      { ...fetchBodyOptions(timeoutMs, maxResponseBytes), onBodyRead: observation.onBodyRead },
    );
    if (!result) {
      throw new Error(`POST fetch failed for ${requestHost(url)}`);
    }
    if (!result.response.ok) {
      await cancelResponseBodyQuietly(result.response);
      throw new Error(`HTTP ${result.response.status} for POST ${requestHost(url)}`);
    }
    return result.body;
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
