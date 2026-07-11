/**
 * Factory for stubbing `worker/src/lib/circuit-breaker` in cron tests.
 *
 * Captures the common shape used by `sync-yield-data-*.test.ts`,
 * `sync-stablecoins.test.ts`, `enrich-prices-*.test.ts`, and
 * `dispatch-telegram-alerts-*.test.ts`: `shouldAttemptFetch` defaults to `true`
 * (circuit closed), `recordOutcome`/`recordOutcomeSafe` are no-ops.
 *
 * Tests can pass pre-built spies to allow `vi.mocked(...).mockResolvedValue(...)`
 * or direct `.mockResolvedValue(...)` overrides referenced by identity.
 */

import { vi } from "vitest";
import type { Mock } from "vitest";
import type { CircuitOutcomeRecord, CircuitRecord } from "../../lib/circuit-breaker";

const DEFAULT_CIRCUIT_RECORD: CircuitRecord = {
  state: "closed",
  consecutiveFailures: 0,
  lastFailureAt: null,
  lastSuccessAt: null,
  openedAt: null,
};

export interface MockCircuitBreakerOptions {
  /** Optional pre-built spy for `shouldAttemptFetch`. Defaults to `vi.fn(async () => true)`. */
  shouldAttemptFetchFn?: Mock;
  /** Optional pre-built spy for `recordOutcome`. Defaults to `vi.fn(async () => {})`. */
  recordOutcomeFn?: Mock;
  /** Optional pre-built spy for `recordOutcomeSafe`. Defaults to `vi.fn(async () => {})`. */
  recordOutcomeSafeFn?: Mock;
}

export interface MockCircuitBreakerExports {
  shouldAttemptFetch: Mock;
  recordOutcome: Mock;
  recordOutcomeSafe: Mock;
}

export function mockCircuitOutcomeRecord(
  before: CircuitRecord = DEFAULT_CIRCUIT_RECORD,
  after: CircuitRecord = before,
): CircuitOutcomeRecord {
  return {
    before: { ...before },
    after: { ...after },
  };
}

/**
 * Build the stubbed export object for `worker/src/lib/circuit-breaker`.
 *
 * Usage (no shared spies — tests use `vi.mocked(shouldAttemptFetch).mockResolvedValue(...)`):
 *   vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker());
 *
 * Usage (shared spies for assertion — dispatch-telegram-alerts pattern):
 *   const mockShouldAttemptFetch = vi.fn();
 *   const mockRecordOutcome = vi.fn();
 *   vi.mock("../../lib/circuit-breaker", () => mockCircuitBreaker({
 *     shouldAttemptFetchFn: mockShouldAttemptFetch,
 *     recordOutcomeFn: mockRecordOutcome,
 *   }));
 */
export function mockCircuitBreaker(
  options: MockCircuitBreakerOptions = {},
): MockCircuitBreakerExports {
  return {
    shouldAttemptFetch: options.shouldAttemptFetchFn ?? vi.fn(async () => true),
    recordOutcome: options.recordOutcomeFn ?? vi.fn(async () => mockCircuitOutcomeRecord()),
    recordOutcomeSafe: options.recordOutcomeSafeFn ?? vi.fn(async () => mockCircuitOutcomeRecord()),
  };
}
