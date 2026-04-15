import { fetchWithRetry } from "../../lib/fetch-retry";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { requireHtmlInput } from "./input-guards";
import type { AdapterContext } from "./types";
import { runAdapterIo } from "./concurrency";

const ADAPTER_USER_AGENT = "Mozilla/5.0";

interface JsonRetryOptions {
  headers?: HeadersInit;
}

function summarizeResponseBody(raw: string, limit = 120): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, limit);
}

function buildJsonParseError(url: string, res: Response, raw: string, error: unknown): Error {
  const contentType = res.headers.get("content-type") ?? "unknown";
  const snippet = summarizeResponseBody(raw);
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(
    `JSON parse failed for ${url} (${contentType}): ${detail}${snippet ? `; body starts with: ${snippet}` : ""}`,
  );
}

function getRequestCache(ctx?: AdapterContext): Map<string, Promise<unknown>> | null {
  return ctx?.requestCache ?? null;
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

  const cached = cache.get(key) as Promise<T> | undefined;
  if (cached) {
    return cached;
  }

  const promise = factory().catch((error) => {
    cache.delete(key);
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
  return getCachedRequest(
    `json-get:${url}:${timeoutMs}:${JSON.stringify(options?.headers ?? null)}`,
    async () => runAdapterIo(ctx, `json-get:${url}`, async () => {
      const res = await fetchWithRetry(
        url,
        {
          signal,
          headers: {
            Accept: "application/json",
            "User-Agent": ADAPTER_USER_AGENT,
            ...(options?.headers ?? {}),
          },
        },
        2,
        { timeoutMs },
      );
      if (!res) {
        throw new Error(`Fetch failed for ${url}`);
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      const raw = await res.text();
      try {
        return JSON.parse(raw) as T;
      } catch (error) {
        throw buildJsonParseError(url, res, raw, error);
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
    `json-post:${url}:${timeoutMs}:${serializedBody}:${JSON.stringify(options?.headers ?? null)}`,
    async () => runAdapterIo(ctx, `json-post:${url}`, async () => {
      const res = await fetchWithRetry(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "User-Agent": ADAPTER_USER_AGENT,
            ...(options?.headers ?? {}),
          },
          body: serializedBody,
          signal,
        },
        2,
        { timeoutMs },
      );
      if (!res) {
        throw new Error(`POST fetch failed for ${url}`);
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`HTTP ${res.status} for POST ${url}`);
      }
      return res.json() as Promise<T>;
    }),
    ctx,
  );
}

export async function fetchTextWithRetry(
  url: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
  ctx?: AdapterContext,
): Promise<string> {
  return getCachedRequest(
    `text-get:${url}:${timeoutMs}`,
    async () => runAdapterIo(ctx, `text-get:${url}`, async () => {
      const res = await fetchWithRetry(
        url,
        {
          signal,
          headers: { "User-Agent": ADAPTER_USER_AGENT },
        },
        2,
        { timeoutMs },
      );
      if (!res) {
        throw new Error(`Fetch failed for ${url}`);
      }
      if (!res.ok) {
        await cancelResponseBodyQuietly(res);
        throw new Error(`HTTP ${res.status} for ${url}`);
      }
      return res.text();
    }),
    ctx,
  );
}

export async function fetchPrimaryHtmlInput(
  config: LiveReservesConfig,
  adapterName: string,
  signal: AbortSignal,
  ctx?: AdapterContext,
  timeoutMs = 15_000,
): Promise<string> {
  const input = requireHtmlInput(config.inputs.primary, adapterName);
  return fetchTextWithRetry(input.url, signal, timeoutMs, ctx);
}
