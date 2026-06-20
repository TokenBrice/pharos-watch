import { vi } from "vitest";

/**
 * Build the common passthrough stub for `worker/src/lib/fetch-retry`.
 *
 * Existing cron tests use this when the retry wrapper itself is not under test
 * and outbound requests are controlled through the global fetch/mockFetch layer.
 */
export function mockFetchRetry() {
  return {
    fetchWithRetry: vi.fn(async (url: string, init?: RequestInit) => fetch(url, init)),
  };
}
