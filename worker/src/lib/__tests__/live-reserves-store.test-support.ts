import { vi } from "vitest";
import * as reviewPolicy from "../reserve-feed-reviews";
import { mockD1 as createMockD1, type MockD1Database, type MockTableConfig } from "@shared/test-utils/mock-d1";
import { computeLiveReserveConfigFingerprint } from "@shared/lib/live-reserve-adapters";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import {
  finalizeReserveSyncSuccess,
  type ReserveCompositionRecord,
  type ReserveSyncStateRecord,
} from "../live-reserves/store";

export const YUZU_REVIEW: (typeof reviewPolicy.RESERVE_FEED_REVIEWS)[number] = {
  stablecoinId: "yzusd-yuzu", adapterKey: "accountable", failureCategory: "unknown", warningCodes: [],
  errorPrefix: "primary:http-json: Accountable exposure_split has no contemporaneous timeline reserve total for reconciliation",
  owner: "ops", reason: "Historical test fixture",
  sources: [{ url: "https://cache.accountable.capital/dashboard/yuzu", evidenceDate: "2026-11-07" }],
  reviewedAt: 1794080812, expiresAt: 1794685612,
};
const resolveReviews = reviewPolicy.resolveReserveFeedReviews, matchReview = reviewPolicy.matchReserveFeedReview;
export function installYuzuReview() {
  vi.spyOn(reviewPolicy, "resolveReserveFeedReviews").mockImplementation((now, reviews) => resolveReviews(now, reviews ?? [YUZU_REVIEW]));
  vi.spyOn(reviewPolicy, "matchReserveFeedReview").mockImplementation((db, state, now, reviews) => matchReview(db, state, now, reviews ?? resolveReviews(now, [YUZU_REVIEW]).activeById));
}

export const LIVE_SLICES = [{ name: "Test Farm", pct: 100, risk: "low" as const }];

export const RESERVE_DEFAULT_TABLES: MockTableConfig[] = [
  { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
  { match: "INSERT INTO cache", rows: [] },
  { match: "FROM reserve_sync_state", rows: [] },
  { match: "FROM reserve_composition", rows: [] },
  { match: "INSERT INTO reserve_sync_state", rows: [] },
  { match: "INSERT INTO reserve_composition", rows: [] },
  { match: "UPDATE reserve_sync_state", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_composition_history", rows: [] },
  { match: "INSERT OR IGNORE INTO reserve_sync_attempt_history", rows: [] },
  { match: "FROM worker_scheduled_checkpoints", rows: [], first: null },
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
  config_fingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get("iusd-infinifi")!.liveReservesConfig!),
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
  const config = WORKER_TRACKED_META_BY_ID.get(String(composition?.stablecoin_id ?? "iusd-infinifi"))?.liveReservesConfig;
  return mockReserveD1([
    {
      match: "reserve_composition",
      rows: [],
      first: composition && { ...COMPOSITION_ROW, config_fingerprint: config ? computeLiveReserveConfigFingerprint(config) : null, ...composition },
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
    configFingerprint: computeLiveReserveConfigFingerprint(WORKER_TRACKED_META_BY_ID.get(overrides.stablecoinId ?? "iusd-infinifi")!.liveReservesConfig!),
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
  return { ...SYNC_STATE_ROW, ...overrides };
}

export function reserveCompositionRow(overrides: MockRow = {}): MockRow {
  const config = WORKER_TRACKED_META_BY_ID.get(String(overrides.stablecoin_id ?? "iusd-infinifi"))?.liveReservesConfig;
  return {
    ...COMPOSITION_ROW,
    config_fingerprint: config ? computeLiveReserveConfigFingerprint(config) : null,
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
