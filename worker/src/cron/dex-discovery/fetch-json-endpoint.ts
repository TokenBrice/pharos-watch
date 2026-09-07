import { USER_AGENT } from "../../lib/constants";
import { fetchJsonWithRetry } from "../../lib/fetch-retry";

export type DexDiscoveryEndpointResult =
  | { kind: "success"; body: unknown }
  | { kind: "failure"; retryable?: true };

export async function fetchDexDiscoveryJsonEndpoint(input: {
  url: string;
  signal: AbortSignal;
  maxRetries: number;
  maxResponseBytes: number;
  timeoutMs: number;
}): Promise<DexDiscoveryEndpointResult> {
  const result = await fetchJsonWithRetry<unknown>(
    input.url,
    {
      signal: input.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    input.maxRetries,
    {
      maxResponseBytes: input.maxResponseBytes,
      returnFinalResponse: true,
      timeoutMs: input.timeoutMs,
    },
  );
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
