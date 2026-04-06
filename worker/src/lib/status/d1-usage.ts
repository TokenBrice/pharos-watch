import type { D1UsageSummary } from "@shared/types/status";
import type { CloudflareD1StatusConfig } from "../env";

interface CloudflareApiEnvelope<T> {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
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

interface D1AnalyticsGraphqlResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        d1AnalyticsAdaptiveGroups?: Array<{
          sum?: {
            readQueries?: number | null;
            writeQueries?: number | null;
            rowsRead?: number | null;
            rowsWritten?: number | null;
          } | null;
        } | null> | null;
      } | null> | null;
    } | null;
  };
  errors?: Array<{ message?: string }>;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getErrorMessage(errors: Array<{ message?: string }> | undefined): string | null {
  const first = errors?.find((error) => typeof error?.message === "string" && error.message.trim().length > 0);
  return first?.message?.trim() ?? null;
}

async function fetchJson<T>(url: string, init: RequestInit, errorPrefix: string): Promise<T> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${errorPrefix} (${response.status})`);
  }
  return await response.json() as T;
}

async function fetchDatabaseInfo(config: CloudflareD1StatusConfig): Promise<D1DatabaseInfoResult> {
  const payload = await fetchJson<CloudflareApiEnvelope<D1DatabaseInfoResult>>(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`,
    {
      headers: {
        "Authorization": `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
    },
    "Cloudflare D1 database info fetch failed",
  );

  if (payload.success === false) {
    throw new Error(getErrorMessage(payload.errors) ?? "Cloudflare D1 database info fetch failed");
  }

  if (!payload.result) {
    throw new Error("Cloudflare D1 database info response was missing result");
  }

  return payload.result;
}

async function fetchAnalytics(
  config: CloudflareD1StatusConfig,
  windowStartIso: string,
  windowEndIso: string,
): Promise<Pick<D1UsageSummary, "readQueries24h" | "writeQueries24h" | "rowsRead24h" | "rowsWritten24h">> {
  const payload = await fetchJson<D1AnalyticsGraphqlResponse>(
    "https://api.cloudflare.com/client/v4/graphql",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `query getD1MetricsOverviewQuery($accountTag: string, $filter: ZoneWorkersRequestsFilter_InputObject) {
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

  if (payload.errors?.length) {
    throw new Error(getErrorMessage(payload.errors) ?? "Cloudflare D1 analytics fetch failed");
  }

  const groups = payload.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  let readQueries = 0;
  let writeQueries = 0;
  let rowsRead = 0;
  let rowsWritten = 0;

  for (const group of groups) {
    readQueries += toNumber(group?.sum?.readQueries) ?? 0;
    writeQueries += toNumber(group?.sum?.writeQueries) ?? 0;
    rowsRead += toNumber(group?.sum?.rowsRead) ?? 0;
    rowsWritten += toNumber(group?.sum?.rowsWritten) ?? 0;
  }

  return {
    readQueries24h: readQueries,
    writeQueries24h: writeQueries,
    rowsRead24h: rowsRead,
    rowsWritten24h: rowsWritten,
  };
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
    ...analytics,
  };
}
