import { assessD1Capacity } from "@shared/lib/d1-capacity";
import type { D1CapacityAssessment, D1UsageSummary } from "@shared/types/status";
import type { CloudflareD1StatusConfig } from "../env";
import { cancelResponseBodyQuietly } from "../response-body";
import { isRecord } from "@shared/lib/type-guards";
import { logWorkerEvent } from "../structured-log";
import {
  D1_CAPACITY_OBSERVATION_INTERVAL_SEC,
  loadCachedD1CapacityAssessment,
  refreshD1CapacityAssessment,
} from "./d1-capacity-store";

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

async function fetchJson(url: string, init: RequestInit, errorPrefix: string): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await cancelResponseBodyQuietly(response);
    throw new Error(`${errorPrefix} (${response.status})`);
  }
  try {
    return await response.json() as unknown;
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
): Promise<D1UsageSummary> {
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
    ...analytics,
  };
}
