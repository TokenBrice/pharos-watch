/**
 * Cron-test mock factories.
 *
 * Scaffolded by W2.10.0 ahead of migrating the four mega-tests
 * (`sync-yield-data-*.test.ts`, `enrich-prices-*.test.ts`,
 * `dispatch-telegram-alerts-*.test.ts`, `sync-stablecoins.test.ts`) onto a
 * shared mocking surface. See the per-file headers for usage patterns.
 */

export { mockRegistry } from "./mock-registry";
export type { MockRegistryOptions, MockRegistryExports, MockRegistryStablecoin } from "./mock-registry";

export { mockDbCache } from "./mock-db-cache";
export type { MockDbCacheOptions, MockDbCacheExports } from "./mock-db-cache";

export { mockCircuitBreaker, mockCircuitOutcomeRecord } from "./mock-circuit-breaker";
export type { MockCircuitBreakerOptions, MockCircuitBreakerExports } from "./mock-circuit-breaker";

export { mockFetchRetry } from "./mock-fetch-retry";
