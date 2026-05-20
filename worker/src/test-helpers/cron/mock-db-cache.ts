/**
 * Factory for stubbing `worker/src/lib/db-cache` in cron tests.
 *
 * Captures the common shape used inline by `sync-yield-data.test.ts`,
 * `sync-stablecoins.test.ts`, and `dispatch-telegram-alerts.test.ts`:
 * benign no-op stubs for `getCache`/`setCache`/`setCacheIfNewer`/
 * `writeFreshnessSentinel`, returned as `vi.fn()` mocks so tests can
 * override per-call via `vi.mocked(getCache).mockImplementation(...)`.
 *
 * Tests can pass `getCacheFn` / `setCacheFn` to inject specific spies
 * referenced by reference identity (the dispatch-telegram-alerts pattern).
 */

import { vi } from "vitest";
import type { Mock } from "vitest";

export interface MockDbCacheOptions {
  /** Optional pre-built spy for `getCache`. Defaults to `vi.fn(async () => null)`. */
  getCacheFn?: Mock;
  /** Optional pre-built spy for `setCache`. Defaults to `vi.fn(async () => {})`. */
  setCacheFn?: Mock;
  /** Optional pre-built spy for `setCacheIfNewer`. */
  setCacheIfNewerFn?: Mock;
  /** Optional pre-built spy for `writeFreshnessSentinel`. */
  writeFreshnessSentinelFn?: Mock;
}

export interface MockDbCacheExports {
  getCache: Mock;
  setCache: Mock;
  setCacheIfNewer: Mock;
  writeFreshnessSentinel: Mock;
}

/**
 * Build the stubbed export object for `worker/src/lib/db-cache`.
 *
 * Usage (no shared spies — tests use `vi.mocked(getCache).mockImplementation(...)`):
 *   vi.mock("../../lib/db-cache", () => mockDbCache());
 *
 * Usage (shared spies for assertion — dispatch-telegram-alerts pattern):
 *   const mockGetCache = vi.fn();
 *   const mockSetCache = vi.fn();
 *   vi.mock("../../lib/db-cache", () => mockDbCache({
 *     getCacheFn: mockGetCache,
 *     setCacheFn: mockSetCache,
 *   }));
 */
export function mockDbCache(options: MockDbCacheOptions = {}): MockDbCacheExports {
  return {
    getCache: options.getCacheFn ?? vi.fn(async () => null),
    setCache: options.setCacheFn ?? vi.fn(async () => {}),
    setCacheIfNewer:
      options.setCacheIfNewerFn ??
      vi.fn(async () => ({ written: true, skippedBecauseNewer: false })),
    writeFreshnessSentinel: options.writeFreshnessSentinelFn ?? vi.fn(async () => {}),
  };
}
