import { toErrorMessage } from "@shared/lib/error-utils";
import { CRON_SCHEDULE_CADENCES } from "@shared/lib/cron-cadences";
import { getCaches, setCacheIfNewer } from "../lib/db-cache";
import { rethrowIfAborted, throwIfAborted } from "../lib/abort";
import { stripSensitive } from "../lib/safe-error-message";
import { sanitizeBoundedMetadata } from "../lib/sensitive-metadata";
import type { CronResult } from "../lib/cron-logger";
import { CRON_SENTINEL_RULE_IDS, type CronSentinelRuleSource } from "./cron-sentinel-rules";

/**
 * Run labels published as `metadata.mode`. `daily` is produced only by
 * `runDailyCronSentinel`; every mode still reconciles the retained state of
 * every source, so the full label set lives here beside `SOURCES_BY_MODE`.
 */
export type CronSentinelMode = "status" | "daily" | "turnover" | "reserve-post-sync";

export interface CronSentinelSourceResult {
  source: CronSentinelRuleSource;
  result: CronResult;
  observedAt?: number;
}

const SOURCES_BY_MODE: Record<CronSentinelMode, readonly CronSentinelRuleSource[]> = {
  status: ["freshness", "digest-publication"],
  daily: ["growth", "duration", "repair-debt"],
  turnover: ["turnover"],
  "reserve-post-sync": ["reserve-post-sync"],
};

// `isDexLiquidityPublicationSlot` admits one of the two half-hourly chart
// slots, so the turnover watchdog publishes hourly even though its host slot
// is half-hourly. Retained state must outlive one real publication interval.
const TURNOVER_INTERVAL_SEC = CRON_SCHEDULE_CADENCES.halfHourlyChartsOffset.intervalSec * 2;

const SOURCE_INTERVAL_SEC: Record<CronSentinelRuleSource, number> = {
  freshness: 15 * 60,
  "digest-publication": 15 * 60,
  growth: 24 * 60 * 60,
  duration: 24 * 60 * 60,
  "repair-debt": 24 * 60 * 60,
  turnover: TURNOVER_INTERVAL_SEC,
  "reserve-post-sync": 4 * 60 * 60,
};
const SOURCE_STATE_MAX_AGE_SEC = 48 * 60 * 60;
const SOURCE_STATE_INTERVAL_MULTIPLIER = 2;

function isRetainedSourceStateFresh(
  source: CronSentinelRuleSource,
  updatedAt: number,
  nowSec: number,
): boolean {
  const maxAgeSec = Math.min(
    SOURCE_STATE_MAX_AGE_SEC,
    SOURCE_INTERVAL_SEC[source] * SOURCE_STATE_INTERVAL_MULTIPLIER,
  );
  return Number.isFinite(updatedAt) && nowSec - updatedAt <= maxAgeSec;
}

function parseMetadata(metadata: string | undefined): unknown {
  if (!metadata) return null;
  try {
    return JSON.parse(metadata) as unknown;
  } catch {
    return metadata;
  }
}

function worstStatus(results: readonly CronResult[]): CronResult["status"] {
  if (results.some((result) => result.status === "error")) return "error";
  if (results.some((result) => result.status === "degraded")) return "degraded";
  if (results.length === 0 || results.every((result) => result.status === "skipped_neutral")) {
    return "skipped_neutral";
  }
  return "ok";
}

function buildCronSentinelResult(
  mode: CronSentinelMode,
  sourceResults: readonly CronSentinelSourceResult[],
): CronResult {
  const results = sourceResults.map(({ result }) => result);
  const status = worstStatus(results);
  const sourceStatuses = Object.fromEntries(
    sourceResults.map(({ source, result }) => [source, result.status ?? "ok"]),
  );
  // One job id multiplexes four watchdog sets, so the row names the mode and
  // the source that produced the worst status instead of collapsing them.
  const attributedSource = status === "ok" || status === undefined
    ? null
    : sourceResults.find(({ result }) => (result.status ?? "ok") === status)?.source ?? null;
  return {
    status,
    itemCount: results.reduce((sum, result) => sum + (result.itemCount ?? 0), 0),
    metadata: JSON.stringify({
      mode,
      sourceStatuses,
      ...(attributedSource ? { reason: `${mode}:${attributedSource}:${status}` } : {}),
      ruleIds: Object.fromEntries(
        sourceResults.map(({ source }) => [source, CRON_SENTINEL_RULE_IDS[source]]),
      ),
      sources: Object.fromEntries(sourceResults.map(({ source, result, observedAt }) => [source, {
        ...(observedAt !== undefined ? { observedAt } : {}),
        status: result.status ?? "ok",
        itemCount: result.itemCount ?? 0,
        metadata: parseMetadata(result.metadata),
        ...(result.error ? { error: result.error } : {}),
      }])),
    }),
  };
}

/** Each independent source clears only its own last evaluated result. */
export async function runCronSentinelSources(
  db: D1Database,
  mode: CronSentinelMode,
  sources: readonly { source: CronSentinelRuleSource; run: () => Promise<CronResult> }[],
  nowSec: number,
  signal?: AbortSignal,
): Promise<CronResult> {
  for (const { source, run } of sources) {
    throwIfAborted(signal);
    let result: CronResult;
    try {
      result = await run();
    } catch (error) {
      rethrowIfAborted(error, signal);
      result = { status: "error", error: stripSensitive(toErrorMessage(error)) };
    }
    if (result.status === "skipped_neutral" || result.status === "skipped_locked" || result.aborted) continue;
    const metadata = sanitizeBoundedMetadata(parseMetadata(result.metadata), {
      maxStringChars: 500, maxStackChars: 500, maxKeys: 40, maxArrayItems: 40, maxDepth: 4,
    });
    await setCacheIfNewer(db, `cron-sentinel:source:${source}`, JSON.stringify({
      status: result.status ?? "ok",
      itemCount: result.itemCount ?? 0,
      metadata: JSON.stringify(metadata),
      ...(result.error ? { error: stripSensitive(result.error).slice(0, 500) } : {}),
    }), nowSec, signal);
  }
  const allSources = [...new Set(Object.values(SOURCES_BY_MODE).flat())];
  const keys = allSources.map((source) => `cron-sentinel:source:${source}`);
  let saved = await getCaches(db, keys);
  // Bootstrap from retained source-specific history once; other modes must not
  // clear warnings that were recorded before per-source cache state existed.
  let seeded = false;
  for (const source of allSources) {
    const key = `cron-sentinel:source:${source}`;
    if (saved.has(key)) continue;
    const previous = await db.prepare(`
      SELECT source_result, started_at FROM (
        SELECT started_at,
          CASE WHEN json_valid(metadata) THEN json_extract(metadata, ?) END AS source_result
        FROM cron_runs WHERE job = 'cron-sentinel'
      )
      WHERE CASE WHEN json_valid(source_result)
        THEN json_extract(source_result, '$.status') IN ('ok', 'degraded', 'error') ELSE 0 END
      ORDER BY started_at DESC LIMIT 1
    `).bind(`$.sources."${source}"`).first<{ source_result: string; started_at: number }>();
    if (!previous) continue;
    const result = JSON.parse(previous.source_result) as CronResult & { observedAt?: number };
    const observedAt = typeof result.observedAt === "number" && Number.isFinite(result.observedAt)
      ? Math.min(result.observedAt, previous.started_at)
      : previous.started_at;
    await setCacheIfNewer(db, key, JSON.stringify({
      ...result,
      itemCount: result.itemCount ?? 0,
      metadata: JSON.stringify(result.metadata ?? null),
    }), observedAt, signal);
    seeded = true;
  }
  if (seeded) saved = await getCaches(db, keys);
  throwIfAborted(signal);
  const results: CronSentinelSourceResult[] = [];
  for (const source of allSources) {
    const row = saved.get(`cron-sentinel:source:${source}`);
    if (!row) continue;
    if (!isRetainedSourceStateFresh(source, row.updatedAt, nowSec)) continue;
    let result: CronResult;
    try {
      result = JSON.parse(row.value) as CronResult;
      if (!result || !["ok", "degraded", "error"].includes(result.status ?? "") ||
        typeof result.itemCount !== "number" || !Number.isFinite(result.itemCount)) throw new Error("Invalid source state");
    } catch {
      result = { status: "error", itemCount: 0, error: "Invalid persisted sentinel source state" };
    }
    results.push({ source, result, observedAt: row.updatedAt });
  }
  return buildCronSentinelResult(mode, results);
}
