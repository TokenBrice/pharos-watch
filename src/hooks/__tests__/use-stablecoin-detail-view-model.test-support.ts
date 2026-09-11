import type { Mock } from "vitest";

export const DISABLED_DETAIL_QUERY_CONTROLS = {
  liquidity: false,
  reportCards: false,
  redemption: false,
  yield: false,
  stress: false,
  flows: false,
  blacklist: false,
  reserves: false,
} as const;

export interface QueryResultOverrides {
  data?: unknown;
  isLoading?: boolean;
  refetch?: Mock;
  error?: Error | null;
  meta?: unknown;
  isError?: boolean;
  reserveResult?: unknown;
  isFetching?: boolean;
}

/**
 * Settled, empty, error-free query-result envelope shared by the mocked detail
 * hooks. Scenario overrides (data, error, reserve shape) stay explicit at each
 * call site so distinct reserve/flow shapes remain visible.
 */
export function queryResult(overrides: QueryResultOverrides = {}) {
  return {
    data: undefined,
    isLoading: false,
    isError: false,
    dataUpdatedAt: 0,
    error: null,
    meta: null,
    ...overrides,
  };
}
