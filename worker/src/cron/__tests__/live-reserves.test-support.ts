import { vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import {
  mockD1 as createMockD1,
  type MockD1Database,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";

export const DEFAULT_LIVE_RESERVE_D1_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "FROM reserve_sync_state", rows: [] },
  { match: "FROM reserve_composition", rows: [] },
  { match: "FROM reserve_sync_attempts", rows: [] },
  { match: "INSERT INTO reserve_sync_state", rows: [] },
  { match: "UPDATE reserve_sync_state", rows: [] },
  { match: "INSERT INTO reserve_composition", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [] },
  { match: "INSERT INTO reserve_sync_attempts", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [] },
  { match: "SELECT key, value, updated_at FROM cache WHERE key IN", rows: [] },
  { match: "SELECT key, value FROM cache WHERE key LIKE 'circuit:%'", rows: [] },
  { match: "SELECT key FROM cache WHERE key LIKE", rows: [] },
  { match: "INSERT OR REPLACE INTO cache", rows: [] },
  { match: "DELETE FROM cache", rows: [] },
  { match: "DELETE FROM reserve_composition_history", rows: [] },
  { match: "DELETE FROM reserve_sync_attempt_history", rows: [] },
];

export function mockLiveReserveD1(
  tables: MockTableConfig[] = [],
  additionalTables: MockTableConfig[] = [],
): MockD1Database {
  return createMockD1([...tables, ...DEFAULT_LIVE_RESERVE_D1_TABLES, ...additionalTables]);
}

const liveReserveMocks = vi.hoisted(() => ({
  getReserveAdapter: vi.fn(),
  shouldAttemptFetch: vi.fn(),
  recordOutcomeSafe: vi.fn(),
  recoverNoCandidate: vi.fn(),
}));

export const getReserveAdapterMock = liveReserveMocks.getReserveAdapter;
export const shouldAttemptFetchMock = liveReserveMocks.shouldAttemptFetch;
export const recordOutcomeSafeMock = liveReserveMocks.recordOutcomeSafe;
export const recoverNoCandidateMock = liveReserveMocks.recoverNoCandidate;

vi.mock("../reserve-adapters/index", () => ({
  getReserveAdapter: liveReserveMocks.getReserveAdapter,
}));

vi.mock("../../lib/circuit-breaker", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/circuit-breaker")>();
  return {
    ...original,
    shouldAttemptFetch: liveReserveMocks.shouldAttemptFetch,
    recordOutcomeSafe: liveReserveMocks.recordOutcomeSafe,
    recoverBreakerOnNoCandidate: liveReserveMocks.recoverNoCandidate,
  };
});

export type LiveReserveAdapterFetchResult = {
  slices: Array<{ name: string; pct: number; risk: "low" }>;
  warnings?: Array<{ code: string; message: string; severity: "warning" }>;
  metadata?: Record<string, unknown>;
};

export type LiveReserveAdapterFetch = (
  coin?: (typeof ACTIVE_STABLECOINS)[number],
  config?: NonNullable<(typeof ACTIVE_STABLECOINS)[number]["liveReservesConfig"]>,
) => Promise<LiveReserveAdapterFetchResult>;

export function mockLiveReserveAdapterRegistry(fetchImpl: LiveReserveAdapterFetch) {
  const fetch = vi.fn(async (coin, config) => {
    const result = await fetchImpl(coin, config);
    return {
      ...result,
      metadata: result.metadata ?? { freshnessMode: "not-applicable" as const },
    };
  });
  getReserveAdapterMock.mockImplementation((adapterKey: keyof typeof LIVE_RESERVE_ADAPTER_DEFINITIONS) => {
    const definition = LIVE_RESERVE_ADAPTER_DEFINITIONS[adapterKey];
    const validation = "validation" in definition ? definition.validation : undefined;
    return {
      key: adapterKey,
      fetch,
      sourceModel: definition.sourceModel,
      evidenceClass: definition.evidenceClass,
      sharedSourceMode: definition.sharedSourceMode,
      ...(validation ? { validation } : {}),
    };
  });
  return fetch;
}
