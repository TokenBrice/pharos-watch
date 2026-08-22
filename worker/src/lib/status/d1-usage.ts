import { assessD1Capacity } from "@shared/lib/d1-capacity";
import type { D1CapacityAssessment, D1UsageSummary } from "@shared/types/status";
import type { CloudflareD1StatusConfig } from "../env";
import { fetchTextWithRetry } from "../fetch-retry";
import { isRecord } from "@shared/lib/type-guards";
import { logWorkerEvent } from "../structured-log";
import { getCache, setCacheIfNewer } from "../db-cache";
import {
  D1_CAPACITY_OBSERVATION_INTERVAL_SEC,
  loadCachedD1CapacityAssessment,
  refreshD1CapacityAssessment,
} from "./d1-capacity-store";

export const D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY = "ops:d1-table-growth:v1";
export const D1_TABLE_GROWTH_RUN_MARKER_CACHE_KEY = "ops:d1-table-growth:last-run:v1";
export const D1_TABLE_GROWTH_SNAPSHOT_INTERVAL_SEC = 24 * 60 * 60;
const D1_TABLE_GROWTH_SNAPSHOT_VERSION = 1;
const D1_TABLE_GROWTH_TOP_N = 10;

export interface D1TableGrowthRow {
  tableName: string;
  rowCount: number;
  previousRowCount: number | null;
  rowCountDelta: number | null;
  oldestTimestamp: number | null;
  newestTimestamp: number | null;
}

export interface D1TableGrowthTopGrower {
  tableName: string;
  rowCount: number;
  rowCountDelta: number;
}

export interface D1TableGrowthSnapshot {
  checkedAt: number;
  utcDay: number;
  previousCheckedAt: number | null;
  tables: D1TableGrowthRow[];
  topGrowers: D1TableGrowthTopGrower[];
}

export type D1UsageSummaryWithTableGrowth = D1UsageSummary & {
  tableGrowth: D1TableGrowthSnapshot | null;
};

interface D1TableGrowthRule {
  name?: string;
  prefix?: string;
}

// Keep this allowlist bounded to append-only or high-write families. The
// sqlite_master query below discovers only tables in these named families;
// table-specific timestamp columns are listed separately because the family
// prefixes contain tables with different schemas.
const D1_TABLE_GROWTH_RULES: D1TableGrowthRule[] = [
  // Daily supply snapshots are the primary expected archive-growth family.
  { name: "supply_history" },
  { prefix: "chain_supply_history" },
  // Scheduler and depeg event history are high-write operational families.
  { prefix: "cron_" },
  { prefix: "depeg_" },
  // Yield and DEX history/staging include the main market-data append paths.
  { prefix: "yield_" },
  { prefix: "dex_" },
  { prefix: "measured_execution_" },
  // Telegram activity and the remaining append-only analytical histories.
  { prefix: "telegram_" },
  { name: "mint_burn_events" },
  { name: "mint_burn_hourly" },
  { name: "reserve_composition_history" },
  { name: "reserve_sync_attempt_history" },
  { name: "stability_index_samples" },
  { name: "stress_signal_history" },
  { name: "stress_signals" },
  { name: "tape_events" },
];

// Only query timestamp columns verified in the migration schema. Tables in a
// matched family without an entry here still receive row-count telemetry.
const D1_TABLE_GROWTH_TIMESTAMP_COLUMNS: Record<string, string> = {
  chain_supply_history: "snapshot_date",
  cron_runs: "started_at",
  cron_run_progress: "started_at",
  cron_slot_executions: "started_at",
  depeg_backfill_runs: "started_at",
  depeg_event_provenance: "created_at",
  depeg_events: "started_at",
  depeg_pending: "first_seen_at",
  depeg_pending_outcomes: "outcome_at",
  depeg_resolver_assessments: "created_at",
  dex_deployment_outcomes: "observed_at",
  dex_discovery_meta: "last_crawl_at",
  dex_liquidity: "updated_at",
  dex_liquidity_history: "snapshot_date",
  dex_measured_execution_quotes: "quoted_at",
  dex_measured_execution_targets: "captured_at",
  dex_pool_staging: "refreshed_at",
  dex_price_challenger_snapshots: "snapshot_at",
  dex_price_challengers: "snapshot_at",
  dex_prices: "updated_at",
  mint_burn_events: "timestamp",
  mint_burn_hourly: "hour_ts",
  reserve_composition_history: "fetched_at",
  reserve_sync_attempt_history: "attempted_at",
  stability_index_samples: "stored_at",
  stability_index: "computed_at",
  stress_signal_history: "snapshot_date",
  stress_signals: "computed_at",
  supply_history: "snapshot_date",
  tape_events: "ts",
  telegram_alert_jobs: "created_at",
  telegram_pending_alerts: "created_at",
  telegram_processed_updates: "received_at",
  telegram_subscribers: "created_at",
  telegram_usage_daily: "last_seen_at",
  telegram_watcher_lifecycle_daily: "snapshot_at",
  yield_data: "updated_at",
  yield_history: "recorded_at",
  yield_publication_generations: "created_at",
  yield_source_decision_alternatives: "recorded_at",
  yield_source_decisions: "created_at",
};

interface D1TableGrowthMeasurement {
  row_count: number | string | null;
  oldest_timestamp?: number | string | null;
  newest_timestamp?: number | string | null;
}

interface D1TableNameRow {
  name?: string | null;
}

interface D1TableGrowthCacheEnvelope {
  version: 1;
  snapshot: D1TableGrowthSnapshot;
}

interface D1DatabaseInfoResult {
  uuid?: string;
  name?: string;
  file_size?: number | string | null;
  num_tables?: number | string | null;
  region?: string | null;
  read_replication?: {
    mode?: string | null;
  } | null;
}

class D1UsagePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "D1UsagePayloadError";
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getErrorMessage(errors: unknown): string | null {
  if (!Array.isArray(errors)) return null;
  for (const error of errors) {
    if (!isRecord(error)) continue;
    const message = error.message;
    if (typeof message === "string" && message.trim().length > 0) {
      return message.trim();
    }
  }
  return null;
}

function parseOptionalString(value: unknown, fieldName: string): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  throw new D1UsagePayloadError(`${fieldName} must be a string when present`);
}

function parseOptionalNumber(value: unknown, fieldName: string): number | null {
  if (value == null) return null;
  const parsed = toNumber(value);
  if (parsed != null) return parsed;
  throw new D1UsagePayloadError(`${fieldName} must be a finite number when present`);
}

function parseDatabaseInfoEnvelope(payload: unknown): D1DatabaseInfoResult {
  if (!isRecord(payload)) {
    throw new D1UsagePayloadError("Cloudflare D1 database info response was not an object");
  }

  if (payload.success === false) {
    throw new D1UsagePayloadError(getErrorMessage(payload.errors) ?? "Cloudflare D1 database info fetch failed");
  }

  if (payload.success !== true) {
    throw new D1UsagePayloadError("Cloudflare D1 database info response was missing success=true");
  }

  if (!isRecord(payload.result)) {
    throw new D1UsagePayloadError("Cloudflare D1 database info response was missing result");
  }

  const readReplication = payload.result.read_replication;
  if (readReplication != null && !isRecord(readReplication)) {
    throw new D1UsagePayloadError("Cloudflare D1 database info read_replication must be an object when present");
  }

  return {
    uuid: parseOptionalString(payload.result.uuid, "Cloudflare D1 database info result.uuid") ?? undefined,
    name: parseOptionalString(payload.result.name, "Cloudflare D1 database info result.name") ?? undefined,
    file_size: parseOptionalNumber(payload.result.file_size, "Cloudflare D1 database info result.file_size"),
    num_tables: parseOptionalNumber(payload.result.num_tables, "Cloudflare D1 database info result.num_tables"),
    region: parseOptionalString(payload.result.region, "Cloudflare D1 database info result.region"),
    read_replication: readReplication
      ? {
          mode: parseOptionalString(readReplication.mode, "Cloudflare D1 database info result.read_replication.mode"),
        }
      : null,
  };
}

function parseAnalyticsMetric(value: unknown, fieldName: string): number {
  if (value == null) return 0;
  const parsed = toNumber(value);
  if (parsed != null) return parsed;
  throw new D1UsagePayloadError(`${fieldName} must be a finite number when present`);
}

function parseAnalyticsEnvelope(
  payload: unknown,
): Pick<D1UsageSummary, "readQueries24h" | "writeQueries24h" | "rowsRead24h" | "rowsWritten24h"> {
  if (!isRecord(payload)) {
    throw new D1UsagePayloadError("Cloudflare D1 analytics response was not an object");
  }

  if (payload.errors != null && !Array.isArray(payload.errors)) {
    throw new D1UsagePayloadError("Cloudflare D1 analytics errors field must be an array when present");
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new D1UsagePayloadError(getErrorMessage(payload.errors) ?? "Cloudflare D1 analytics fetch failed");
  }

  if (!isRecord(payload.data)) {
    throw new D1UsagePayloadError("Cloudflare D1 analytics response was missing data");
  }
  if (!isRecord(payload.data.viewer)) {
    throw new D1UsagePayloadError("Cloudflare D1 analytics response was missing viewer");
  }
  if (!Array.isArray(payload.data.viewer.accounts)) {
    throw new D1UsagePayloadError("Cloudflare D1 analytics response was missing accounts");
  }

  const account = payload.data.viewer.accounts[0];
  if (!isRecord(account)) {
    throw new D1UsagePayloadError("Cloudflare D1 analytics response was missing account");
  }
  if (!Array.isArray(account.d1AnalyticsAdaptiveGroups)) {
    throw new D1UsagePayloadError("Cloudflare D1 analytics response was missing d1AnalyticsAdaptiveGroups");
  }

  let readQueries = 0;
  let writeQueries = 0;
  let rowsRead = 0;
  let rowsWritten = 0;

  for (const group of account.d1AnalyticsAdaptiveGroups) {
    if (!isRecord(group)) {
      throw new D1UsagePayloadError("Cloudflare D1 analytics group must be an object");
    }
    if (!isRecord(group.sum)) {
      throw new D1UsagePayloadError("Cloudflare D1 analytics group was missing sum");
    }
    readQueries += parseAnalyticsMetric(group.sum.readQueries, "Cloudflare D1 analytics sum.readQueries");
    writeQueries += parseAnalyticsMetric(group.sum.writeQueries, "Cloudflare D1 analytics sum.writeQueries");
    rowsRead += parseAnalyticsMetric(group.sum.rowsRead, "Cloudflare D1 analytics sum.rowsRead");
    rowsWritten += parseAnalyticsMetric(group.sum.rowsWritten, "Cloudflare D1 analytics sum.rowsWritten");
  }

  return {
    readQueries24h: readQueries,
    writeQueries24h: writeQueries,
    rowsRead24h: rowsRead,
    rowsWritten24h: rowsWritten,
  };
}

function parseD1TableGrowthSnapshot(value: string): D1TableGrowthSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed.version !== D1_TABLE_GROWTH_SNAPSHOT_VERSION) return null;
  if (!isRecord(parsed.snapshot) || !Array.isArray(parsed.snapshot.tables)) return null;
  if (!Array.isArray(parsed.snapshot.topGrowers)) return null;
  if (typeof parsed.snapshot.checkedAt !== "number" || typeof parsed.snapshot.utcDay !== "number") return null;
  return parsed.snapshot as unknown as D1TableGrowthSnapshot;
}

function buildD1TableGrowthDiscoveryQuery(): { sql: string; binds: unknown[] } {
  const exactNames = D1_TABLE_GROWTH_RULES.flatMap((rule) => rule.name ? [rule.name] : []);
  const prefixes = D1_TABLE_GROWTH_RULES.flatMap((rule) => rule.prefix ? [rule.prefix] : []);
  const predicates: string[] = [];
  const binds: unknown[] = [];
  if (exactNames.length > 0) {
    predicates.push(`name IN (${exactNames.map(() => "?").join(", ")})`);
    binds.push(...exactNames);
  }
  for (const prefix of prefixes) {
    predicates.push("substr(name, 1, ?) = ?");
    binds.push(prefix.length, prefix);
  }
  return {
    sql: `SELECT name
            FROM sqlite_master
           WHERE type = 'table'
             AND (${predicates.join(" OR ")})
           ORDER BY name`,
    binds,
  };
}

function quoteD1Identifier(value: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return null;
  return `"${value}"`;
}

async function readD1TableGrowthMeasurement(
  db: D1Database,
  tableName: string,
): Promise<D1TableGrowthMeasurement | null> {
  const quotedTableName = quoteD1Identifier(tableName);
  if (!quotedTableName) return null;
  const timestampColumn = D1_TABLE_GROWTH_TIMESTAMP_COLUMNS[tableName];
  const quotedTimestampColumn = timestampColumn ? quoteD1Identifier(timestampColumn) : null;
  const timestampProjection = quotedTimestampColumn
    ? `, MIN(${quotedTimestampColumn}) AS oldest_timestamp, MAX(${quotedTimestampColumn}) AS newest_timestamp`
    : "";
  return db
    .prepare(`SELECT COUNT(*) AS row_count${timestampProjection} FROM ${quotedTableName}`)
    .first<D1TableGrowthMeasurement>();
}

async function claimD1TableGrowthRun(db: D1Database, utcDay: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
       WHERE cache.updated_at < excluded.updated_at`,
    )
    .bind(
      D1_TABLE_GROWTH_RUN_MARKER_CACHE_KEY,
      JSON.stringify({ version: D1_TABLE_GROWTH_SNAPSHOT_VERSION, utcDay }),
      utcDay,
    )
    .run();
  return result.meta.changes > 0;
}

export async function loadCachedD1TableGrowthSnapshot(
  db: D1Database,
): Promise<D1TableGrowthSnapshot | null> {
  const cached = await getCache(db, D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY);
  return cached ? parseD1TableGrowthSnapshot(cached.value) : null;
}

export async function refreshD1TableGrowthSnapshot(
  db: D1Database,
  observedAt: number,
): Promise<D1TableGrowthSnapshot | null> {
  const utcDay = Math.floor(observedAt / D1_TABLE_GROWTH_SNAPSHOT_INTERVAL_SEC)
    * D1_TABLE_GROWTH_SNAPSHOT_INTERVAL_SEC;
  const claimed = await claimD1TableGrowthRun(db, utcDay);
  if (!claimed) return loadCachedD1TableGrowthSnapshot(db);

  const previous = await loadCachedD1TableGrowthSnapshot(db);
  const discovery = buildD1TableGrowthDiscoveryQuery();
  const discovered = await db
    .prepare(discovery.sql)
    .bind(...discovery.binds)
    .all<D1TableNameRow>();
  const previousByTable = new Map((previous?.tables ?? []).map((row) => [row.tableName, row]));
  const tables: D1TableGrowthRow[] = [];

  // Keep these reads serial: the Worker cron lanes share a small D1 connection pool.
  for (const discoveredRow of discovered.results ?? []) {
    const tableName = discoveredRow.name;
    if (typeof tableName !== "string") continue;
    const measurement = await readD1TableGrowthMeasurement(db, tableName);
    if (!measurement) continue;
    const rowCount = Math.max(0, toNumber(measurement.row_count) ?? 0);
    const previousRow = previousByTable.get(tableName);
    tables.push({
      tableName,
      rowCount,
      previousRowCount: previousRow?.rowCount ?? null,
      rowCountDelta: previousRow ? rowCount - previousRow.rowCount : null,
      oldestTimestamp: toNumber(measurement.oldest_timestamp),
      newestTimestamp: toNumber(measurement.newest_timestamp),
    });
  }

  const topGrowers = tables
    .filter((row): row is D1TableGrowthRow & { rowCountDelta: number } => row.rowCountDelta != null && row.rowCountDelta > 0)
    .sort((left, right) => right.rowCountDelta - left.rowCountDelta || left.tableName.localeCompare(right.tableName))
    .slice(0, D1_TABLE_GROWTH_TOP_N)
    .map((row) => ({
      tableName: row.tableName,
      rowCount: row.rowCount,
      rowCountDelta: row.rowCountDelta,
    }));
  const snapshot: D1TableGrowthSnapshot = {
    checkedAt: observedAt,
    utcDay,
    previousCheckedAt: previous?.checkedAt ?? null,
    tables,
    topGrowers,
  };
  const envelope: D1TableGrowthCacheEnvelope = {
    version: D1_TABLE_GROWTH_SNAPSHOT_VERSION,
    snapshot,
  };
  await setCacheIfNewer(
    db,
    D1_TABLE_GROWTH_SNAPSHOT_CACHE_KEY,
    JSON.stringify(envelope),
    observedAt,
  );
  return snapshot;
}

async function fetchJson(url: string, init: RequestInit, errorPrefix: string): Promise<unknown> {
  const result = await fetchTextWithRetry(url, init, 0, {
    timeoutMs: 5_000,
    maxResponseBytes: 2 * 1024 * 1024,
    returnFinalResponse: true,
  });
  if (!result) throw new Error(errorPrefix);
  if (!result.response.ok) throw new Error(`${errorPrefix} (${result.response.status})`);
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    throw new Error(`${errorPrefix}: invalid JSON response`);
  }
}

async function fetchDatabaseInfo(config: CloudflareD1StatusConfig): Promise<D1DatabaseInfoResult> {
  const payload = await fetchJson(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`,
    {
      headers: {
        "Authorization": `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
    },
    "Cloudflare D1 database info fetch failed",
  );
  return parseDatabaseInfoEnvelope(payload);
}

async function assessDatabaseCapacity(
  databaseInfo: D1DatabaseInfoResult,
  nowSeconds: number,
  db?: D1Database,
): Promise<D1CapacityAssessment | null> {
  const databaseSizeBytes = toNumber(databaseInfo.file_size);
  if (databaseSizeBytes == null) return null;

  if (!db) {
    return assessD1Capacity({ observedAt: nowSeconds, databaseSizeBytes });
  }

  try {
    const cached = await loadCachedD1CapacityAssessment(
      db,
      nowSeconds,
      D1_CAPACITY_OBSERVATION_INTERVAL_SEC,
    );
    if (cached) return cached;
    return await refreshD1CapacityAssessment(db, databaseSizeBytes, nowSeconds);
  } catch (error) {
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "d1_capacity_observation_failed",
      route: "status",
      source: "cloudflare-d1-status",
      message: "D1 capacity observation persistence failed; returning a point-in-time assessment",
      error,
    });
    return assessD1Capacity({ observedAt: nowSeconds, databaseSizeBytes });
  }
}

export async function getD1CapacityAssessmentFromCloudflare(
  config: CloudflareD1StatusConfig,
  db: D1Database,
  nowSeconds: number,
): Promise<D1CapacityAssessment | null> {
  const databaseInfo = await fetchDatabaseInfo(config);
  return assessDatabaseCapacity(databaseInfo, nowSeconds, db);
}

async function fetchAnalytics(
  config: CloudflareD1StatusConfig,
  windowStartIso: string,
  windowEndIso: string,
): Promise<Pick<D1UsageSummary, "readQueries24h" | "writeQueries24h" | "rowsRead24h" | "rowsWritten24h">> {
  const payload = await fetchJson(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query getD1MetricsOverviewQuery($accountTag: string, $filter: d1AnalyticsAdaptiveGroupsFilter_InputObject) {
          viewer {
            accounts(filter: {accountTag: $accountTag}) {
              d1AnalyticsAdaptiveGroups(limit: 10000, filter: $filter) {
                sum {
                  readQueries
                  writeQueries
                  rowsRead
                  rowsWritten
                }
              }
            }
          }
        }`,
        operationName: "getD1MetricsOverviewQuery",
        variables: {
          accountTag: config.accountId,
          filter: {
            AND: [
              {
                datetimeHour_geq: windowStartIso,
                datetimeHour_leq: windowEndIso,
                databaseId: config.databaseId,
              },
            ],
          },
        },
      }),
    },
    "Cloudflare D1 analytics fetch failed",
  );
  return parseAnalyticsEnvelope(payload);
}

export async function getCacheBlobSizes(db: D1Database): Promise<Record<string, number>> {
  const rows = await db
    .prepare("SELECT key, LENGTH(value) as bytes FROM cache")
    .all<{ key: string; bytes: number }>();
  const sizes: Record<string, number> = {};
  for (const row of rows.results ?? []) {
    sizes[row.key] = row.bytes;
  }
  return sizes;
}

export async function getD1UsageSummary(
  config: CloudflareD1StatusConfig,
  nowSeconds: number,
  db?: D1Database,
): Promise<D1UsageSummaryWithTableGrowth> {
  const checkedAt = nowSeconds;
  const windowEnd = nowSeconds;
  const windowStart = Math.max(0, nowSeconds - 86_400);
  const windowStartIso = new Date(windowStart * 1000).toISOString();
  const windowEndIso = new Date(windowEnd * 1000).toISOString();

  const [databaseInfo, analytics] = await Promise.all([
    fetchDatabaseInfo(config),
    fetchAnalytics(config, windowStartIso, windowEndIso),
  ]);
  const capacity = await assessDatabaseCapacity(databaseInfo, nowSeconds, db);
  let tableGrowth: D1TableGrowthSnapshot | null = null;
  if (db) {
    try {
      tableGrowth = await loadCachedD1TableGrowthSnapshot(db);
    } catch (error) {
      logWorkerEvent({
        scope: "status",
        level: "warn",
        event: "d1_table_growth_snapshot_read_failed",
        route: "status",
        source: "d1-table-growth",
        message: "D1 table growth snapshot read failed; returning usage telemetry without the additive snapshot",
        error,
      });
    }
  }

  return {
    checkedAt,
    windowStart,
    windowEnd,
    databaseId: databaseInfo.uuid ?? config.databaseId,
    databaseName: typeof databaseInfo.name === "string" ? databaseInfo.name : null,
    databaseSizeBytes: toNumber(databaseInfo.file_size),
    numTables: toNumber(databaseInfo.num_tables),
    region: typeof databaseInfo.region === "string" ? databaseInfo.region : null,
    readReplicationMode: typeof databaseInfo.read_replication?.mode === "string"
      ? databaseInfo.read_replication.mode
      : null,
    capacity,
    tableGrowth,
    ...analytics,
  };
}
