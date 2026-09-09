import { vi } from "vitest";
import { LIVE_RESERVE_ADAPTER_DEFINITIONS } from "@shared/lib/live-reserve-adapters";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { LIVE_RESERVE_QUEUE_HASH } from "../sync-live-reserves-shared";
import {
  mockD1 as createMockD1,
  type MockD1Database,
  type MockTableConfig,
} from "@shared/test-utils/mock-d1";
import type { ScheduledCheckpointIdentity } from "../../lib/scheduled-recovery-checkpoint";

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

export interface LiveReserveCheckpointTableOptions {
  attemptNo: number;
  invocationId: string;
  nextItemKey: string | null;
  itemsDone: number;
  state?: "running" | "recovering";
  queueHash?: string;
  itemsTotal?: number;
  sourceAttemptNo?: number | null;
  slotStartedAt?: number;
  currentItemKey?: string | null;
  currentDomainAttemptId?: string | null;
  recoveryOwner?: string | null;
  recoveryLeaseUntil?: number | null;
}

export function checkpointTable(input: LiveReserveCheckpointTableOptions): MockTableConfig {
  const slotStartedAt = input.slotStartedAt ?? 1_000;
  const configuredCoinCount = ACTIVE_STABLECOINS.filter((coin) => coin.liveReservesConfig).length;
  return {
    match: "FROM worker_scheduled_checkpoints",
    rows: [{
      schedule_key: "fourHourlyReserveSync",
      slot_started_at: slotStartedAt,
      job: "sync-live-reserves",
      attempt_no: input.attemptNo,
      execution_generation: input.attemptNo,
      invocation_id: input.invocationId,
      worker_version: "version-a",
      queue_hash: input.queueHash ?? LIVE_RESERVE_QUEUE_HASH,
      state: input.state ?? "recovering",
      next_item_key: input.nextItemKey,
      current_item_key: input.currentItemKey ?? null,
      current_domain_attempt_id: input.currentDomainAttemptId ?? null,
      items_done: input.itemsDone,
      items_total: input.itemsTotal ?? configuredCoinCount,
      child_dispositions_json: JSON.stringify({ "sync-live-reserves": "not_started" }),
      recovery_owner: input.recoveryOwner ?? input.invocationId,
      recovery_lease_until: input.recoveryLeaseUntil ?? 2_000,
      source_attempt_no: input.sourceAttemptNo === undefined
        ? input.attemptNo - 1
        : input.sourceAttemptNo,
      error: null,
      created_at: slotStartedAt,
      updated_at: slotStartedAt + 100,
      completed_at: null,
    }],
  };
}

export function checkpointIdentity(
  attemptNo: number,
  invocationId: string,
  slotStartedAt = 1_000,
): ScheduledCheckpointIdentity {
  return {
    scheduleKey: "fourHourlyReserveSync",
    slotStartedAt,
    job: "sync-live-reserves",
    attemptNo,
    executionGeneration: attemptNo,
    invocationId,
  };
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
