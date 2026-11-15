import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";

export type DexDiscoveryEndpointResult =
  | { kind: "success"; body: unknown }
  | { kind: "failure"; retryable?: true };

export async function fetchDexDiscoveryJsonEndpoint(input: {
  url: string;
  /** A JSON request body turns the read into a POST (GraphQL query). */
  body?: string;
  signal: AbortSignal;
  maxRetries: number;
  maxResponseBytes: number;
  timeoutMs: number;
}): Promise<DexDiscoveryEndpointResult> {
  // The stage signal spans every attempt and retry wait, so a hung read, a long
  // Retry-After or the coin deadline makes the retry helper throw. That is a
  // retryable miss for this provider, not a failed coin crawl; callers rethrow
  // their own parent cancellation right after this call.
  const result = await fetchJsonWithRetry<unknown>(
    input.url,
    {
      signal: input.signal,
      ...(input.body === undefined ? {} : { method: "POST", body: input.body }),
      headers: {
        Accept: "application/json",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        "User-Agent": USER_AGENT,
      },
    },
    input.maxRetries,
    {
      maxResponseBytes: input.maxResponseBytes,
      returnFinalResponse: true,
      timeoutMs: input.timeoutMs,
    },
  ).catch(() => null);
  if (result == null) return { kind: "failure", retryable: true };
  if (!result.response.ok) {
    const retryable =
      result.response.status === 408 ||
      result.response.status === 425 ||
      result.response.status === 429 ||
      result.response.status >= 500;
    return retryable ? { kind: "failure", retryable: true } : { kind: "failure" };
  }
  return { kind: "success", body: result.body };
}
