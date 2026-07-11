import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";
import {
  mockD1,
  type MockD1Database,
  type MockD1Options,
  type MockTableConfig,
} from "../../test-helpers/__shared/mock-d1";
import { buildPendingAlertRow, mockCircuitBreaker, mockDbCache } from "../../test-helpers/cron";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { getAlertSafetySourceGeneration } from "../../lib/alert-safety-source-cache";
import type { CronProgressUpdate } from "../../lib/cron-logger";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();

const STABLECOINS_CACHE_WITH_USDC = JSON.stringify({
  peggedAssets: [
    {
      id: "usdc-circle",
      symbol: "USDC",
      name: "USD Coin",
      pegType: "peggedUSD",
      price: 1,
      circulating: { peggedUSD: 50_000_000_000 },
    },
  ],
});

vi.mock("../../lib/db-cache", () =>
  mockDbCache({
    getCacheFn: mockGetCache,
    setCacheFn: mockSetCache,
  }),
);

const mockShouldAttemptFetch = vi.fn();
const mockRecordOutcome = vi.fn();
const mockInspectLegacyOverflowBacklog = vi.fn();

vi.mock("../../lib/circuit-breaker", () =>
  mockCircuitBreaker({
    shouldAttemptFetchFn: mockShouldAttemptFetch,
    recordOutcomeFn: mockRecordOutcome,
  }),
);

vi.mock("../telegram-legacy-overflow-import", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../telegram-legacy-overflow-import")>();
  return {
    ...actual,
    inspectAndImportLegacyOverflowBacklog: mockInspectLegacyOverflowBacklog,
  };
});

const mockSendToChat = vi.fn();
const mockSendBatch = vi.fn();

vi.mock("../../lib/telegram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram")>();
  return {
    ...actual,
    sendToChat: mockSendToChat,
    sendBatch: mockSendBatch,
  };
});

// Count `formatConsolidatedMessage` invocations while preserving behavior, so the
// C102 budget-before-format reorder can be asserted (format-count <= fresh budget
// + allowance, not once per candidate).
const formatConsolidatedMessageSpy = vi.fn();
vi.mock("../../lib/telegram-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/telegram-alerts")>();
  return {
    ...actual,
    formatConsolidatedMessage: (...args: Parameters<typeof actual.formatConsolidatedMessage>) => {
      formatConsolidatedMessageSpy(...args);
      return actual.formatConsolidatedMessage(...args);
    },
  };
});

const { dispatchTelegramAlerts } = await import("../dispatch-telegram-alerts");
const { deliverTelegramSubscriberQueue } = await import("../dispatch-telegram-delivery");
const { pruneOverflowPlanBacklogForChat } = await import("../dispatch-telegram-overflow");
const { buildDedupeKey, emptyDrainResult } = await import("../telegram-pending");
const { TELEGRAM_MAX_MESSAGES_PER_RUN, TELEGRAM_FORMAT_BUDGET_ALLOWANCE, TELEGRAM_DISPATCH_SOFT_DEADLINE_MS } =
  await import("../../lib/telegram-constants");

function makeSafetySourceCache(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  publishedAt: number,
) {
  return {
    value: JSON.stringify({
      generation: getAlertSafetySourceGeneration(),
      methodologyVersion: "7.10",
      publishedAt,
      snapshot,
    }),
    updatedAt: publishedAt,
  };
}

function makeSafetySnapshotCache(
  snapshot: Record<string, { grade: string; score: number | null; methodologyVersion: string | null }>,
  generation = getAlertSafetySourceGeneration(),
) {
  return {
    value: JSON.stringify({
      generation,
      snapshot,
    }),
    updatedAt: Math.floor(Date.now() / 1000) - 60,
  };
}

function makeDewsOverflowPlan(now: number, chatId = "chat-overflow") {
  return {
    chatId,
    alertType: "dews" as const,
    estimatedChunks: 1,
    entry: {
      lastActiveAt: now,
      alerts: {
        dews: [
          {
            stablecoinId: "usdc-circle",
            symbol: "USDC",
            oldBand: "CALM",
            newBand: "WARNING",
            score: 55,
            topSignals: [],
          },
        ],
        depegTriggered: [],
        depegResolved: [],
        depegWorsening: [],
        safety: [],
        launch: [],
        reserve: [],
      },
      quietHoursEnabled: false,
      quietHoursStartUtc: null,
      quietHoursEndUtc: null,
      timezone: null,
      specificCount: 1,
      globalCount: 0,
    },
  };
}

function countPendingAlertInsertBatches(db: MockD1Database): () => number {
  const originalBatch = db.batch.bind(db);
  let pendingInsertBatchCount = 0;
  db.batch = (async (statements: D1PreparedStatement[]) => {
    if (
      statements.some((statement) =>
        ((statement as { sql?: string }).sql ?? "").includes("INSERT INTO telegram_pending_alerts"),
      )
    ) {
      pendingInsertBatchCount += 1;
    }
    return originalBatch(statements);
  }) as D1Database["batch"];
  return () => pendingInsertBatchCount;
}

function parseLogRecords(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
}
function resetDispatchTelegramAlertsTest() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-23T12:00:00Z"));

  mockGetCache.mockReset();
  mockSetCache.mockReset();
  formatConsolidatedMessageSpy.mockReset();
  mockShouldAttemptFetch.mockReset();
  mockRecordOutcome.mockReset();
  mockInspectLegacyOverflowBacklog.mockReset();
  mockSendToChat.mockReset();
  mockSendBatch.mockReset();

  mockShouldAttemptFetch.mockResolvedValue(true);
  mockSetCache.mockResolvedValue(undefined);
  mockRecordOutcome.mockResolvedValue(undefined);
  mockInspectLegacyOverflowBacklog.mockResolvedValue({
    state: "absent",
    digest: null,
    sourceEventId: null,
    observedBytes: 0,
    observedPlanCount: null,
    importCursor: 0,
    importedTargetCount: 0,
    errorClass: null,
  });
  mockSendToChat.mockResolvedValue({
    ok: true,
    blocked: false,
    retryable: false,
    permanentFailure: false,
    statusCode: 200,
    errorClass: null,
    delivery: "sent",
    retryAfterSec: null,
  });

  // Default sendBatch: delegate each message to mockSendToChat
  mockSendBatch.mockImplementation(
    async (messages: Array<{ chatId: string; html: string; disableNotification: boolean }>, _botToken: string) => {
      const results = [];
      for (const msg of messages) {
        const result = await mockSendToChat(msg.chatId, msg.html, _botToken, {});
        results.push({ chatId: msg.chatId, ...result });
      }
      return results;
    },
  );
}

function cleanupDispatchTelegramAlertsTest() {
  vi.useRealTimers();
  while (fixtureSqliteDatabases.length > 0) fixtureSqliteDatabases.pop()?.close();
}

const SQLITE_DISPATCH_TABLES = [
  "telegram_alert_source_events",
  "telegram_alert_source_resolution_pages",
  "telegram_alert_source_resolution_memberships",
  "telegram_alert_source_resolution_targets",
  "telegram_alert_planning_subscribers",
  "telegram_alert_target_plan_pages",
  "telegram_alert_target_plans",
  "telegram_alert_target_plan_items",
  "telegram_alert_target_expiry_progress",
  "telegram_alert_jobs",
  "telegram_alert_job_targets",
  "telegram_alert_job_target_items",
  "telegram_pending_alerts",
  "telegram_alert_dead_letters",
  "telegram_chat_delivery_diagnostics",
  "telegram_delivery_pauses",
  "telegram_transport_circuit",
  "telegram_transport_failure_observations",
  "telegram_legacy_overflow_state",
] as const;

const ALERT_FAMILIES = ["dews", "depeg", "safety", "launch", "reserve"] as const;
type AlertFamily = (typeof ALERT_FAMILIES)[number];

interface SeedSubscriber {
  chatId: string;
  createdAt: number;
  lastActiveAt: number;
  preferenceGeneration: number;
  alertSnoozeUntilTs: number | null;
  quietHoursEnabled: number;
  quietHoursStartUtc: number | null;
  quietHoursEndUtc: number | null;
  timezone: string | null;
  globalDepegWorseningBpsStep: number | null;
  global: Record<AlertFamily, number>;
}

interface HybridPreparedStatement extends D1PreparedStatement {
  sql: string;
  boundValues: unknown[];
  backend: "canned" | "sqlite";
  inner: D1PreparedStatement;
}

const fixtureSqliteDatabases: DatabaseSync[] = [];
let latestMigrationSql: string | null = null;

function loadLatestMigrationSql(): string {
  if (latestMigrationSql != null) return latestMigrationSql;
  const migrationDir = process.cwd().endsWith("/worker")
    ? join(process.cwd(), "migrations")
    : join(process.cwd(), "worker/migrations");
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migrations only.
  latestMigrationSql = readdirSync(migrationDir)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((file) => {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- checked-in migrations only.
      return readFileSync(join(migrationDir, file), "utf8");
    })
    .join("\n");
  return latestMigrationSql;
}

function latestSchemaSqlite(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(loadLatestMigrationSql());
  fixtureSqliteDatabases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function rowNumber(row: Record<string, unknown>, key: string, fallback: number): number {
  const value = Number(row[key]);
  return Number.isFinite(value) ? value : fallback;
}

function rowNullableNumber(row: Record<string, unknown>, key: string): number | null {
  return row[key] == null ? null : rowNumber(row, key, 0);
}

function ensureSeedSubscriber(
  subscribers: Map<string, SeedSubscriber>,
  row: Record<string, unknown>,
): SeedSubscriber | null {
  if (typeof row.chat_id !== "string" || row.chat_id.length === 0) return null;
  const lastActiveAt = rowNumber(row, "last_active_at", rowNumber(row, "created_at", Math.floor(Date.now() / 1000)));
  const existing = subscribers.get(row.chat_id);
  const subscriber: SeedSubscriber = existing ?? {
    chatId: row.chat_id,
    createdAt: Math.max(0, lastActiveAt - 1),
    lastActiveAt,
    preferenceGeneration: 0,
    alertSnoozeUntilTs: null,
    quietHoursEnabled: 0,
    quietHoursStartUtc: null,
    quietHoursEndUtc: null,
    timezone: null,
    globalDepegWorseningBpsStep: null,
    global: { dews: 0, depeg: 0, safety: 0, launch: 0, reserve: 0 },
  };
  subscriber.createdAt = Math.min(subscriber.createdAt, rowNumber(row, "created_at", Math.max(0, lastActiveAt - 1)));
  subscriber.lastActiveAt = Math.max(subscriber.lastActiveAt, lastActiveAt);
  subscriber.preferenceGeneration = Math.max(
    subscriber.preferenceGeneration,
    rowNumber(row, "preference_generation", 0),
  );
  subscriber.alertSnoozeUntilTs = row.alert_snooze_until_ts == null
    ? subscriber.alertSnoozeUntilTs
    : rowNullableNumber(row, "alert_snooze_until_ts");
  subscriber.quietHoursEnabled = Math.max(
    subscriber.quietHoursEnabled,
    rowNumber(row, "quiet_hours_enabled", 0),
  );
  subscriber.quietHoursStartUtc ??= rowNullableNumber(row, "quiet_hours_start_utc");
  subscriber.quietHoursEndUtc ??= rowNullableNumber(row, "quiet_hours_end_utc");
  subscriber.timezone ??= typeof row.timezone === "string" ? row.timezone : null;
  subscriber.globalDepegWorseningBpsStep ??= rowNullableNumber(row, "global_depeg_worsening_bps_step");
  subscribers.set(row.chat_id, subscriber);
  return subscriber;
}

function seedFixtureRows(sqlite: DatabaseSync, tables: MockTableConfig[]): void {
  const subscribers = new Map<string, SeedSubscriber>();
  const subscriptions = new Map<string, Record<string, unknown>>();
  const presets = new Map<string, Record<string, unknown>>();
  const pendingRows = new Map<string, Record<string, unknown>>();
  const sourceRows = new Map<string, Record<string, unknown>>();

  for (const table of tables) {
    const rows = table.first ? [...table.rows, table.first] : table.rows;
    const directFamily = ALERT_FAMILIES.find((family) => table.match.includes(`sub.alert_${family} = 1`));
    const globalFamily = ALERT_FAMILIES.find((family) => table.match.includes(`global_alert_${family} = 1`));
    for (const row of rows) {
      if (!row) continue;
      const subscriber = ensureSeedSubscriber(subscribers, row);
      if (subscriber && globalFamily) subscriber.global[globalFamily] = 1;
      if (subscriber && directFamily && typeof row.stablecoin_id === "string") {
        const key = `${subscriber.chatId}\u0000${row.stablecoin_id}`;
        subscriptions.set(key, { ...subscriptions.get(key), ...row, [`alert_${directFamily}`]: 1 });
      }
      if (subscriber && typeof row.stablecoin_id === "string" && row.alert_snooze_until_ts != null) {
        const key = `${subscriber.chatId}\u0000${row.stablecoin_id}`;
        subscriptions.set(key, { ...subscriptions.get(key), ...row });
      }
      if (
        subscriber &&
        typeof row.stablecoin_id === "string" &&
        table.match === "FROM telegram_subscriptions\n          WHERE stablecoin_id IN"
      ) {
        const key = `${subscriber.chatId}\u0000${row.stablecoin_id}`;
        subscriptions.set(key, {
          ...subscriptions.get(key),
          ...row,
          alert_snooze_until_ts: Math.floor(Date.now() / 1000) + 3_600,
        });
      }
      if (subscriber && typeof row.preset_id === "string") {
        const key = `${subscriber.chatId}\u0000${row.preset_id}`;
        presets.set(key, { ...presets.get(key), ...row });
      }
      if (typeof row.message_html === "string") {
        const key = row.id != null ? `id:${String(row.id)}` : `dedupe:${String(row.dedupe_key)}`;
        pendingRows.set(key, row);
      } else if (typeof row.dedupe_key === "string" && row.attempts != null) {
        pendingRows.set(`dedupe:${row.dedupe_key}`, {
          chat_id: "fixture-dedupe",
          message_html: "<b>Fixture pending alert</b>",
          disable_notification: 0,
          ...row,
        });
      } else if (
        table.match.includes("SELECT chat_id, MAX(not_before_at)") &&
        subscriber &&
        row.not_before_at != null
      ) {
        pendingRows.set(`backoff:${subscriber.chatId}`, {
          chat_id: subscriber.chatId,
          message_html: "<b>Fixture backoff marker</b>",
          disable_notification: 0,
          created_at: Math.floor(Date.now() / 1000),
          not_before_at: row.not_before_at,
          source_type: "legacy",
        });
      }
      if (
        typeof row.source_event_id === "string" &&
        typeof row.event_payload === "string" &&
        typeof row.baseline_payload === "string"
      ) {
        sourceRows.set(row.source_event_id, { ...sourceRows.get(row.source_event_id), ...row });
      } else if (sourceRows.size === 1 && row.target_plan_state != null) {
        const [sourceEventId, source] = [...sourceRows.entries()][0];
        sourceRows.set(sourceEventId, { ...source, ...row });
      }
    }
  }

  const insertSubscriber = sqlite.prepare(
    `INSERT INTO telegram_subscribers (
       chat_id, created_at, last_active_at, preference_generation,
       alert_snooze_until_ts, quiet_hours_enabled, quiet_hours_start_utc,
       quiet_hours_end_utc, timezone, global_alert_dews, global_alert_depeg,
       global_alert_safety, global_alert_launch, global_alert_reserve,
       global_depeg_worsening_bps_step
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       last_active_at = excluded.last_active_at,
       preference_generation = excluded.preference_generation`,
  );
  for (const subscriber of subscribers.values()) {
    insertSubscriber.run(
      subscriber.chatId,
      subscriber.createdAt,
      subscriber.lastActiveAt,
      subscriber.preferenceGeneration,
      subscriber.alertSnoozeUntilTs,
      subscriber.quietHoursEnabled,
      subscriber.quietHoursStartUtc,
      subscriber.quietHoursEndUtc,
      subscriber.timezone,
      subscriber.global.dews,
      subscriber.global.depeg,
      subscriber.global.safety,
      subscriber.global.launch,
      subscriber.global.reserve,
      subscriber.globalDepegWorseningBpsStep,
    );
  }

  const insertSubscription = sqlite.prepare(
    `INSERT INTO telegram_subscriptions (
       chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety,
       alert_launch, alert_reserve, dews_min_band, safety_mode,
       depeg_worsening_bps_step, alert_snooze_until_ts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
       alert_dews = excluded.alert_dews,
       alert_depeg = excluded.alert_depeg,
       alert_safety = excluded.alert_safety,
       alert_launch = excluded.alert_launch,
       alert_reserve = excluded.alert_reserve,
       alert_snooze_until_ts = excluded.alert_snooze_until_ts`,
  );
  for (const row of subscriptions.values()) {
    insertSubscription.run(
      String(row.chat_id),
      String(row.stablecoin_id),
      rowNumber(row, "alert_dews", 0),
      rowNumber(row, "alert_depeg", 0),
      rowNumber(row, "alert_safety", 0),
      rowNumber(row, "alert_launch", 0),
      rowNumber(row, "alert_reserve", 0),
      typeof row.dews_min_band === "string" ? row.dews_min_band : null,
      typeof row.safety_mode === "string" ? row.safety_mode : null,
      rowNullableNumber(row, "depeg_worsening_bps_step"),
      rowNullableNumber(row, "alert_snooze_until_ts"),
    );
  }

  const insertPreset = sqlite.prepare(
    `INSERT INTO telegram_preset_subscriptions (
       chat_id, preset_id, alert_dews, alert_depeg, alert_safety,
       depeg_worsening_bps_step, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of presets.values()) {
    const now = Math.floor(Date.now() / 1000);
    insertPreset.run(
      String(row.chat_id),
      String(row.preset_id),
      rowNumber(row, "alert_dews", 0),
      rowNumber(row, "alert_depeg", 0),
      rowNumber(row, "alert_safety", 0),
      rowNullableNumber(row, "depeg_worsening_bps_step"),
      rowNumber(row, "created_at", now),
      rowNumber(row, "updated_at", now),
    );
  }

  const insertPending = sqlite.prepare(
    `INSERT OR IGNORE INTO telegram_pending_alerts (
       id, chat_id, message_html, disable_notification, created_at, attempts,
       not_before_at, dedupe_key, chunk_index, priority, source_type, alert_type,
       expires_at, updated_at, last_error_class, retry_after_sec,
       processing_owner, processing_started_at, processing_expires_at,
       delivery_state, delivery_started_at, delivery_completed_at,
       source_event_id, alert_scope_json, preference_generation,
       markup_policy_json, delivery_owner, delivery_generation,
       delivery_claim_expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let syntheticPendingId = 1_000_000;
  for (const row of pendingRows.values()) {
    insertPending.run(
      row.id == null ? syntheticPendingId++ : Number(row.id),
      String(row.chat_id),
      String(row.message_html),
      rowNumber(row, "disable_notification", 0),
      rowNumber(row, "created_at", Math.floor(Date.now() / 1000)),
      rowNumber(row, "attempts", 0),
      rowNullableNumber(row, "not_before_at"),
      typeof row.dedupe_key === "string" ? row.dedupe_key : null,
      rowNullableNumber(row, "chunk_index"),
      rowNumber(row, "priority", 50),
      typeof row.source_type === "string" ? row.source_type : "legacy",
      typeof row.alert_type === "string" ? row.alert_type : null,
      rowNullableNumber(row, "expires_at"),
      rowNumber(row, "updated_at", rowNumber(row, "created_at", Math.floor(Date.now() / 1000))),
      typeof row.last_error_class === "string" ? row.last_error_class : null,
      rowNullableNumber(row, "retry_after_sec"),
      typeof row.processing_owner === "string" ? row.processing_owner : null,
      rowNullableNumber(row, "processing_started_at"),
      rowNullableNumber(row, "processing_expires_at"),
      typeof row.delivery_state === "string" ? row.delivery_state : "pending",
      rowNullableNumber(row, "delivery_started_at"),
      rowNullableNumber(row, "delivery_completed_at"),
      typeof row.source_event_id === "string" ? row.source_event_id : null,
      typeof row.alert_scope_json === "string" ? row.alert_scope_json : null,
      rowNullableNumber(row, "preference_generation"),
      typeof row.markup_policy_json === "string" ? row.markup_policy_json : null,
      typeof row.delivery_owner === "string" ? row.delivery_owner : null,
      rowNumber(row, "delivery_generation", 0),
      rowNullableNumber(row, "delivery_claim_expires_at"),
    );
  }

  const insertSource = sqlite.prepare(
    `INSERT OR REPLACE INTO telegram_alert_source_events (
       source_event_id, schema_version, status, detected_at, expires_at,
       event_payload, baseline_payload, attempt_count, last_attempt_at,
       last_error_class, baseline_committed_at, completed_at,
       target_plan_state, target_plan_generation
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of sourceRows.values()) {
    insertSource.run(
      String(row.source_event_id),
      rowNumber(row, "schema_version", 1),
      typeof row.status === "string" ? row.status : "planned",
      rowNumber(row, "detected_at", Math.floor(Date.now() / 1000)),
      rowNumber(row, "expires_at", Math.floor(Date.now() / 1000) + 3_600),
      typeof row.event_payload === "string" ? row.event_payload : "{}",
      typeof row.baseline_payload === "string" ? row.baseline_payload : "{}",
      rowNumber(row, "attempt_count", 0),
      rowNullableNumber(row, "last_attempt_at"),
      typeof row.last_error_class === "string" ? row.last_error_class : null,
      rowNullableNumber(row, "baseline_committed_at"),
      rowNullableNumber(row, "completed_at"),
      typeof row.target_plan_state === "string" ? row.target_plan_state : "unstarted",
      rowNumber(row, "target_plan_generation", 0),
    );
  }
}

function shouldUseSqlite(sql: string): boolean {
  if (SQLITE_DISPATCH_TABLES.some((table) => sql.includes(table))) return true;
  if (
    sql.includes("FROM telegram_subscriptions sub") &&
    sql.includes("sub.chat_id IN")
  ) return true;
  if (
    sql.includes("FROM telegram_subscribers") &&
    sql.includes("global_alert_") &&
    sql.includes("chat_id IN")
  ) return true;
  if (
    sql.includes("FROM telegram_subscriptions") &&
    sql.includes("chat_id IN")
  ) return true;
  if (
    sql.includes("FROM telegram_subscribers") &&
    (
      sql.includes("created_at <=") ||
      sql.includes("SELECT chat_id, preference_generation") ||
      sql.includes("global_alert_reserve") && sql.includes("WHERE chat_id IN")
    )
  ) return true;
  if (
    sql.includes("FROM telegram_subscriptions") &&
    sql.includes("alert_dews_override")
  ) return true;
  if (
    sql.includes("FROM telegram_preset_subscriptions") &&
    sql.includes("SELECT chat_id, preset_id, alert_dews")
  ) return true;
  return false;
}

function filterAuthoritativeSubscriberPage<T>(
  sql: string,
  boundValues: readonly unknown[],
  result: T,
): T {
  if (
    typeof result !== "object" ||
    result === null ||
    !("results" in result) ||
    !/\b(?:sub\.|p\.)?chat_id IN \(/.test(sql)
  ) return result;
  const rows = (result as { results?: Array<Record<string, unknown>> }).results;
  if (!rows) return result;
  const boundStrings = new Set(boundValues.filter((value): value is string => typeof value === "string"));
  return {
    ...result,
    results: rows.filter((row) => typeof row.chat_id !== "string" || boundStrings.has(row.chat_id)),
  } as T;
}

function fixtureMockD1(tables: MockTableConfig[] = [], options: MockD1Options = {}): MockD1Database {
  const canned = mockD1(tables, options);
  const { sqlite, db: sqliteDb } = latestSchemaSqlite();
  seedFixtureRows(sqlite, tables);
  const history: Array<{ sql: string; binds: unknown[] }> = [];

  function statement(
    sql: string,
    boundValues: unknown[] = [],
    backend: "canned" | "sqlite" = shouldUseSqlite(sql) ? "sqlite" : "canned",
  ): HybridPreparedStatement {
    const source = backend === "sqlite" ? sqliteDb : canned;
    const inner = source.prepare(sql).bind(...boundValues);
    const execute = async <T>(method: "all" | "first" | "run"): Promise<T> => {
      history.push({ sql, binds: [...boundValues] });
      const result = await inner[method]() as T;
      return backend === "canned" && method === "all"
        ? filterAuthoritativeSubscriberPage(sql, boundValues, result)
        : result;
    };
    return {
      sql,
      boundValues: [...boundValues],
      backend,
      inner,
      bind: (...args: unknown[]) => statement(sql, args, backend),
      all: <T>() => execute<D1Result<T>>("all"),
      first: <T>() => execute<T | null>("first"),
      run: <T>() => execute<D1Result<T>>("run"),
    } as unknown as HybridPreparedStatement;
  }

  const db = {
    prepare: (sql: string) => statement(sql),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const hybrid = statements as HybridPreparedStatement[];
      for (const item of hybrid) history.push({ sql: item.sql, binds: [...item.boundValues] });
      if (hybrid.every((item) => item.backend === "sqlite")) {
        return sqliteDb.batch<T>(hybrid.map((item) => item.inner));
      }
      const results: D1Result<T>[] = [];
      for (const item of hybrid) {
        results.push(await item.inner.run<T>());
      }
      return results;
    },
    exec: (query: string) => sqliteDb.exec(query),
    dump: () => sqliteDb.dump(),
    getHistory: () => history.map((entry) => ({ sql: entry.sql, binds: [...entry.binds] })),
    assertAllMatchesUsed: () => canned.assertAllMatchesUsed(),
  } as unknown as MockD1Database;
  return db;
}
const fixtureBuildPendingAlertRow = buildPendingAlertRow;

export {
  mockGetCache,
  mockSetCache,
  STABLECOINS_CACHE_WITH_USDC,
  mockShouldAttemptFetch,
  mockRecordOutcome,
  mockInspectLegacyOverflowBacklog,
  mockSendToChat,
  mockSendBatch,
  formatConsolidatedMessageSpy,
  dispatchTelegramAlerts,
  deliverTelegramSubscriberQueue,
  pruneOverflowPlanBacklogForChat,
  buildDedupeKey,
  emptyDrainResult,
  TELEGRAM_MAX_MESSAGES_PER_RUN,
  TELEGRAM_FORMAT_BUDGET_ALLOWANCE,
  TELEGRAM_DISPATCH_SOFT_DEADLINE_MS,
  makeSafetySourceCache,
  makeSafetySnapshotCache,
  makeDewsOverflowPlan,
  countPendingAlertInsertBatches,
  parseLogRecords,
  resetDispatchTelegramAlertsTest,
  cleanupDispatchTelegramAlertsTest,
  type MockD1Database,
  type CronProgressUpdate,
  fixtureMockD1,
  fixtureBuildPendingAlertRow,
};
