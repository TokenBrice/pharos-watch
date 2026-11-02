/**
 * Shared-process hygiene for the non-isolated `worker-shared` project.
 *
 * Files enter that project only after `scripts/lib/critical-ownership.mts`
 * classifies them as owning no per-file module state. Reusing one module cache
 * still means undoing every global, timer and module-level cache the previous
 * file may have left behind, so this setup runs after every test. Only worker
 * modules are reset here — the stateful modules these suites reach plus the
 * shared log/attribution counters a stray retry could touch; frontend and
 * Pages state stays out of this project.
 */
import { afterEach, vi } from "vitest";

import { resetChainRegistryStateForTests } from "../lib/chain-registry";
import { resetCircuitBreakerStateForTests } from "../lib/circuit-breaker";
import { __resetCronFailureCountsForTests } from "../lib/cron-logger";
import { resetRequestAttributionStateForTests } from "../lib/request-source-attribution";
import { resetRpcProviderBudgetStateForTests } from "../lib/rpc-provider-budget";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  resetChainRegistryStateForTests();
  resetCircuitBreakerStateForTests();
  __resetCronFailureCountsForTests();
  resetRequestAttributionStateForTests();
  resetRpcProviderBudgetStateForTests();
});
