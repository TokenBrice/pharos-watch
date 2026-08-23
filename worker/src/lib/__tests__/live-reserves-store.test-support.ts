import { mockD1 as createMockD1, type MockD1Database, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import {
  finalizeReserveSyncSuccess,
  type ReserveCompositionRecord,
  type ReserveSyncStateRecord,
} from "../live-reserves-store";

export const LIVE_SLICES = [{ name: "Test Farm", pct: 100, risk: "low" as const }];

export const RESERVE_DEFAULT_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "FROM reserve_sync_state", rows: [] },
  { match: "FROM reserve_composition", rows: [] },
  { match: "INSERT INTO reserve_sync_state", rows: [] },
  { match: "INSERT INTO reserve_composition", rows: [] },
  { match: "UPDATE reserve_sync_state", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [] },
  {
    match: "SELECT 1 AS finalized FROM reserve_composition c JOIN reserve_sync_state",
    rows: [],
    first: null,
  },
];

export function mockReserveD1(tables: MockTableConfig[] = []): MockD1Database {
  return createMockD1([...tables, ...RESERVE_DEFAULT_TABLES]);
}

type MockRow = Record<string, unknown>;

const COMPOSITION_ROW: MockRow = {
  stablecoin_id: "iusd-infinifi",
  slices: JSON.stringify(LIVE_SLICES),
  fetched_at: 1_000,
  source: "infinifi",
};

const SYNC_STATE_ROW: MockRow = {
  stablecoin_id: "iusd-infinifi",
  adapter_key: "infinifi",
  breaker_key: "live-reserves:infinifi",
  last_attempted_at: 1_000,
  last_success_at: 1_000,
  last_status: "ok",
  warning_count: 0,
  warnings: null,
  last_error: null,
  metadata: "{}",
};

export function makeReservesDb(
  overrides: { composition?: MockRow | null; syncState?: MockRow | null } = {},
): MockD1Database {
  const composition = overrides.composition === undefined ? {} : overrides.composition;
  const syncState = overrides.syncState === undefined ? {} : overrides.syncState;
  return mockReserveD1([
    {
      match: "reserve_composition",
      rows: [],
      first: composition && { ...COMPOSITION_ROW, ...composition },
    },
    {
      match: "reserve_sync_state",
      rows: [],
      first: syncState && { ...SYNC_STATE_ROW, ...syncState },
    },
  ]);
}

export function reserveCompositionInput(
  attemptId: string,
  overrides: Partial<ReserveCompositionRecord> = {},
): ReserveCompositionRecord {
  return {
    stablecoinId: "iusd-infinifi",
    slices: LIVE_SLICES,
    fetchedAt: 1_000,
    source: "infinifi",
    attemptId,
    metadata: {},
    warningCount: 0,
    warnings: [],
    adapterSourceModel: "dynamic-mix",
    adapterEvidenceClass: "independent",
    ...overrides,
  };
}

export function reserveSyncStateInput(
  attemptId: string,
  overrides: Partial<ReserveSyncStateRecord> = {},
): ReserveSyncStateRecord {
  return {
    stablecoinId: "iusd-infinifi",
    adapterKey: "infinifi",
    breakerKey: "live-reserves:infinifi",
    lastAttemptedAt: 1_000,
    lastSuccessAt: 1_000,
    lastStatus: "ok",
    warningCount: 0,
    warnings: [],
    lastError: null,
    metadata: {},
    lastAttemptId: attemptId,
    pendingAttemptId: attemptId,
    lastSuccessAttemptId: attemptId,
    ...overrides,
  };
}

export async function finalizeReserveSuccess(
  db: D1Database,
  attemptId: string,
  overrides: {
    composition?: Partial<ReserveCompositionRecord>;
    syncState?: Partial<ReserveSyncStateRecord>;
    finalizeDeadlineMs?: number;
    onAuthoritativeWrite?: () => Promise<void>;
  } = {},
): ReturnType<typeof finalizeReserveSyncSuccess> {
  return finalizeReserveSyncSuccess(
    db,
    reserveCompositionInput(attemptId, overrides.composition),
    reserveSyncStateInput(attemptId, overrides.syncState),
    overrides.finalizeDeadlineMs ?? Date.now() + 30_000,
    overrides.onAuthoritativeWrite,
  );
}

export function reserveSyncRow(overrides: MockRow = {}): MockRow {
  return {
    stablecoin_id: "iusd-infinifi",
    adapter_key: "infinifi",
    breaker_key: "live-reserves:infinifi",
    last_attempted_at: 1_000,
    last_success_at: 1_000,
    last_status: "ok",
    warning_count: 0,
    warnings: null,
    last_error: null,
    metadata: "{}",
    ...overrides,
  };
}

export function reserveCompositionRow(overrides: MockRow = {}): MockRow {
  return {
    stablecoin_id: "iusd-infinifi",
    slices: JSON.stringify(LIVE_SLICES),
    fetched_at: 1_000,
    source: "infinifi",
    ...overrides,
  };
}

export function reserveSyncAttemptInput(attemptId: string) {
  return {
    stablecoinId: "iusd-infinifi",
    adapterKey: "infinifi",
    breakerKey: "live-reserves:infinifi",
    attemptedAt: 1_000,
    attemptId,
  };
}
