import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import type { CanaryStatus, CanaryRunSeverity, CanaryRunStatus } from "@shared/types/status";
import { REPORT_CARD_CACHE_GENERATION, REPORT_CARD_CACHE_MAX_AGE_MS, loadReportCardCache } from "./report-card-cache";
import { loadStablecoinsCache, hasUsableStablecoinsPayload } from "./stablecoins-cache";
import { evaluateStablecoinPublicationCoverage } from "./stablecoin-publication-coverage";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { isMissingColumnError, isMissingTableError } from "./db";
import { toErrorMessage } from "./error-utils";
import { throwIfAborted } from "./abort";
import { boundedJson, parseObjectMetadata } from "./json-metadata";
import { getCache } from "./db-cache";
import { parseRiskFreeRatesCache } from "../cron/yield-sync/cache";
import { loadPublishedStressSignalGeneration } from "./stress-signals-current-rows";
import { isCurrentSafetyScoreV8Identity } from "./safety-score-current-identity";
import type { WorkerCanaryMode } from "./worker-canary-mode";

export { normalizeWorkerCanaryMode } from "./worker-canary-mode";
export type { WorkerCanaryMode } from "./worker-canary-mode";

export interface CanaryCheckResult {
  checkId: string;
  label: string;
  description: string;
  status: CanaryRunStatus;
  severity: CanaryRunSeverity;
  observedAt: number;
  durationMs: number;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export interface RunCanaryChecksOptions {
  observedAt?: number;
  signal?: AbortSignal;
  mode?: WorkerCanaryMode;
}

export interface CanaryRunSummary {
  mode: WorkerCanaryMode;
  observedAt: number;
  totalChecks: number;
  okCount: number;
  degradedCount: number;
  errorCount: number;
  skippedCount: number;
  worstStatus: CanaryRunStatus;
  worstSeverity: CanaryRunSeverity;
  results: CanaryCheckResult[];
}

interface DexCurrentSummaryRow {
  row_count: number | null;
  unpublished_rows: number | null;
  generation_count: number | null;
  latest_updated_at: number | null;
}

interface DexLatestGenerationSummaryRow {
  latest_generation_rows: number | null;
  retained_legacy_rows: number | null;
  retained_older_published_rows: number | null;
}

interface DexPublishedGenerationRow {
  generation_id: string;
  current_row_count: number | null;
  expected_row_count: number | null;
  published_at: number | null;
}

interface DexGlobalRow {
  current_rows: number | null;
  global_rows: number | null;
}

interface PsiLatestRow {
  stored_at: number;
  score: number;
  band: string;
  methodology_version: string;
}

interface WorkerCanaryRunRow {
  check_id: string;
  status: CanaryRunStatus;
  severity: CanaryRunSeverity;
  observed_at: number;
  duration_ms: number | null;
  metadata_json: string | null;
  error: string | null;
}

type CanaryCheckDefinition = {
  checkId: string;
  label: string;
  description: string;
  run: (db: D1Database, observedAt: number, signal?: AbortSignal) => Promise<Omit<CanaryCheckResult, "checkId" | "label" | "description" | "observedAt" | "durationMs">>;
};

const CANARY_STATUS_ORDER: Record<CanaryRunStatus, number> = {
  skipped: 0,
  ok: 1,
  degraded: 2,
  error: 3,
};

const CANARY_SEVERITY_ORDER: Record<CanaryRunSeverity, number> = {
  info: 0,
  warning: 1,
  error: 2,
  critical: 3,
};

const MAX_CANARY_METADATA_JSON_CHARS = 4_000;
const MAX_CANARY_ERROR_CHARS = 800;
const CANARY_STATUS_MAX_AGE_SEC = 2 * 3600;
export const WORKER_CANARY_RUN_RETENTION_SEC = 90 * 24 * 3600;
const PSI_MAX_AGE_SEC = 4 * 3600;
const DEWS_MAX_AGE_SEC = 4 * 3600;
const GBP_BENCHMARK_MAX_FETCH_AGE_SEC = 48 * 3600;
const GBP_BENCHMARK_MAX_RECORD_AGE_SEC = 7 * 24 * 3600;
const GBP_BENCHMARK_FRESH_STREAK_CACHE_KEY = "fetch-tbill-rate:gbp-retained-fallback-streak";

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function boundedText(value: string, maxChars = MAX_CANARY_ERROR_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function skippedResult(reason: string, metadata?: Record<string, unknown>) {
  return {
    status: "skipped" as const,
    severity: "info" as const,
    error: reason,
    metadata,
  };
}

function unavailableResult(error: unknown) {
  const reason = isMissingTableError(error) || isMissingColumnError(error)
    ? "canary source unavailable; migration/table not present"
    : "canary source unavailable";
  return skippedResult(reason, { error: boundedText(toErrorMessage(error)) });
}

function isFiniteScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isScoreInRange(value: unknown): value is number {
  return isFiniteScore(value) && value >= 0 && value <= 100;
}

function worstStatus(results: readonly Pick<CanaryCheckResult, "status">[]): CanaryRunStatus {
  return results.reduce<CanaryRunStatus>(
    (worst, result) => CANARY_STATUS_ORDER[result.status] > CANARY_STATUS_ORDER[worst] ? result.status : worst,
    "ok",
  );
}

function worstSeverity(results: readonly Pick<CanaryCheckResult, "severity">[]): CanaryRunSeverity {
  return results.reduce<CanaryRunSeverity>(
    (worst, result) => CANARY_SEVERITY_ORDER[result.severity] > CANARY_SEVERITY_ORDER[worst] ? result.severity : worst,
    "info",
  );
}

async function checkStablecoinsCacheActiveCount(db: D1Database) {
  const cache = await loadStablecoinsCache(db, { mode: "lenient", allowLegacyArray: true });
  const expectedActiveCount = ACTIVE_IDS.size;
  if (!hasUsableStablecoinsPayload(cache)) {
    return {
      status: "error" as const,
      severity: "error" as const,
      error: `stablecoins cache ${cache.reason}`,
      metadata: {
        expectedActiveCount,
        updatedAt: cache.updatedAt,
        reason: cache.reason,
      },
    };
  }

  const cachedIds = new Set(cache.payload.peggedAssets.map((asset) => asset.id));
  const coverage = evaluateStablecoinPublicationCoverage(cachedIds);
  const activeCount = coverage.presentActiveCount;
  const metadata = {
    activeCount,
    expectedActiveCount,
    cachedAssetCount: cache.payload.peggedAssets.length,
    updatedAt: cache.updatedAt,
    missingActiveIds: coverage.missingActiveIds,
    waivedActiveIds: coverage.waivedActiveIds,
    expiredWaiverIds: coverage.expiredWaiverIds,
    cacheKind: cache.kind,
  };
  if (!coverage.complete) {
    return {
      status: "degraded" as const,
      severity: "warning" as const,
      error:
        `stablecoins cache active coverage ${activeCount}/${expectedActiveCount}; ` +
        `missing=${coverage.missingActiveIds.join(",")}`,
      metadata,
    };
  }
  return { status: "ok" as const, severity: "info" as const, metadata };
}

async function loadDexCurrentSummary(db: D1Database): Promise<DexCurrentSummaryRow> {
  return (await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT
           COUNT(*) AS row_count,
           SUM(CASE WHEN publication_generation_id IS NOT NULL AND publication_state != 'published' THEN 1 ELSE 0 END) AS unpublished_rows,
           COUNT(DISTINCT publication_generation_id) AS generation_count,
           MAX(updated_at) AS latest_updated_at
         FROM dex_liquidity`,
      )
      .first<DexCurrentSummaryRow>(),
  )) ?? { row_count: 0, unpublished_rows: 0, generation_count: 0, latest_updated_at: null };
}

async function loadLatestPublishedDexGeneration(db: D1Database): Promise<DexPublishedGenerationRow | null> {
  return runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT generation_id, current_row_count, expected_row_count, published_at
           FROM dex_liquidity_publication_generations
          WHERE state = 'published'
          ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC
          LIMIT 1`,
      )
      .first<DexPublishedGenerationRow>(),
  );
}

async function loadDexLatestGenerationCurrentSummary(
  db: D1Database,
  generationId: string,
): Promise<DexLatestGenerationSummaryRow> {
  return (await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT
           SUM(CASE WHEN publication_generation_id = ? AND publication_state = 'published' THEN 1 ELSE 0 END) AS latest_generation_rows,
           SUM(CASE WHEN publication_generation_id IS NULL THEN 1 ELSE 0 END) AS retained_legacy_rows,
           SUM(CASE WHEN publication_generation_id IS NOT NULL AND publication_generation_id != ? AND publication_state = 'published' THEN 1 ELSE 0 END) AS retained_older_published_rows
         FROM dex_liquidity`,
      )
      .bind(generationId, generationId)
      .first<DexLatestGenerationSummaryRow>(),
  )) ?? { latest_generation_rows: 0, retained_legacy_rows: 0, retained_older_published_rows: 0 };
}

async function checkDexCurrentPublication(db: D1Database) {
  try {
    const summary = await loadDexCurrentSummary(db);
    const rowCount = Number(summary.row_count ?? 0);
    const unpublishedRows = Number(summary.unpublished_rows ?? 0);
    const latestPublished = await loadLatestPublishedDexGeneration(db);
    const metadata = {
      rowCount,
      unpublishedRows,
      generationCount: Number(summary.generation_count ?? 0),
      latestUpdatedAt: summary.latest_updated_at,
      latestPublishedGenerationId: latestPublished?.generation_id ?? null,
      latestPublishedRows: latestPublished?.current_row_count ?? null,
      latestPublishedExpectedRows: latestPublished?.expected_row_count ?? null,
      latestPublishedAt: latestPublished?.published_at ?? null,
      latestGenerationPublishedRows: null as number | null,
      retainedLegacyRows: null as number | null,
      retainedOlderPublishedRows: null as number | null,
    };

    if (rowCount === 0) {
      return skippedResult("dex_liquidity has no current rows", metadata);
    }
    if (unpublishedRows > 0) {
      return {
        status: "error" as const,
        severity: "error" as const,
        error: `${unpublishedRows} current DEX liquidity rows are not published`,
        metadata,
      };
    }
    if (!latestPublished) {
      return skippedResult("no DEX liquidity published generation found", metadata);
    }
    const latestGenerationSummary = await loadDexLatestGenerationCurrentSummary(db, latestPublished.generation_id);
    const latestGenerationPublishedRows = Number(latestGenerationSummary.latest_generation_rows ?? 0);
    const retainedLegacyRows = Number(latestGenerationSummary.retained_legacy_rows ?? 0);
    const retainedOlderPublishedRows = Number(latestGenerationSummary.retained_older_published_rows ?? 0);
    metadata.latestGenerationPublishedRows = latestGenerationPublishedRows;
    metadata.retainedLegacyRows = retainedLegacyRows;
    metadata.retainedOlderPublishedRows = retainedOlderPublishedRows;

    if (
      latestPublished.current_row_count != null &&
      latestGenerationPublishedRows !== latestPublished.current_row_count
    ) {
      return {
        status: "error" as const,
        severity: "error" as const,
        error: `DEX latest-generation rows ${latestGenerationPublishedRows} differ from latest published generation ${latestPublished.current_row_count}`,
        metadata,
      };
    }
    return { status: "ok" as const, severity: "info" as const, metadata };
  } catch (error) {
    return unavailableResult(error);
  }
}

async function checkDexGlobalRow(db: D1Database) {
  try {
    const row = (await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT
             COUNT(*) AS current_rows,
             SUM(CASE WHEN stablecoin_id = '__global__' THEN 1 ELSE 0 END) AS global_rows
           FROM dex_liquidity
           WHERE publication_generation_id IS NULL OR publication_state = 'published'`,
        )
        .first<DexGlobalRow>(),
    )) ?? { current_rows: 0, global_rows: 0 };
    const currentRows = Number(row.current_rows ?? 0);
    const globalRows = Number(row.global_rows ?? 0);
    const metadata = { currentRows, globalRows };
    if (currentRows === 0) {
      return skippedResult("dex_liquidity has no published current rows", metadata);
    }
    if (globalRows !== 1) {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: `expected one DEX __global__ row, found ${globalRows}`,
        metadata,
      };
    }
    return { status: "ok" as const, severity: "info" as const, metadata };
  } catch (error) {
    return unavailableResult(error);
  }
}

async function checkPsiLatestSample(db: D1Database, observedAt: number) {
  try {
    const row = await runWithOverloadRetry(() =>
      db
        .prepare(
          `SELECT stored_at, score, band, methodology_version
             FROM stability_index_samples
            ORDER BY stored_at DESC
            LIMIT 1`,
        )
        .first<PsiLatestRow>(),
    );
    if (!row) {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: "no PSI stability_index_samples rows found",
        metadata: { maxAgeSec: PSI_MAX_AGE_SEC },
      };
    }
    const ageSec = Math.max(0, observedAt - row.stored_at);
    const metadata = {
      storedAt: row.stored_at,
      ageSec,
      maxAgeSec: PSI_MAX_AGE_SEC,
      score: row.score,
      band: row.band,
      methodologyVersion: row.methodology_version,
    };
    if (!isScoreInRange(row.score)) {
      return {
        status: "error" as const,
        severity: "error" as const,
        error: `latest PSI score is out of range: ${String(row.score)}`,
        metadata,
      };
    }
    if (ageSec > PSI_MAX_AGE_SEC) {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: `latest PSI sample is ${ageSec}s old`,
        metadata,
      };
    }
    return { status: "ok" as const, severity: "info" as const, metadata };
  } catch (error) {
    return unavailableResult(error);
  }
}

async function checkDewsLatestSignal(db: D1Database, observedAt: number) {
  try {
    const published = await loadPublishedStressSignalGeneration(db, observedAt);
    if (published.status !== "ok") {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: `DEWS published generation unavailable: ${published.reason}`,
        metadata: {
          sourceTable: "stress_signals",
          publicationStatus: "unavailable",
          publicationReason: published.reason,
          maxAgeSec: DEWS_MAX_AGE_SEC,
        },
      };
    }
    const rowCount = published.rows.length;
    const outOfRangeScores = published.rows.filter((row) => !isScoreInRange(row.score)).length;
    const latestComputedAt = published.computedAt;
    const ageSec = Math.max(0, observedAt - latestComputedAt);
    const metadata = {
      sourceTable: "stress_signals",
      rowCount,
      latestComputedAt,
      ageSec,
      maxAgeSec: DEWS_MAX_AGE_SEC,
      outOfRangeScores,
      exactCoverageVerified: published.exactCoverageVerified,
    };
    if (!published.exactCoverageVerified) {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: "DEWS published generation uses legacy coverage evidence",
        metadata,
      };
    }
    if (outOfRangeScores > 0) {
      return {
        status: "error" as const,
        severity: "error" as const,
        error: `${outOfRangeScores} DEWS stress signals have out-of-range scores`,
        metadata,
      };
    }
    if (ageSec != null && ageSec > DEWS_MAX_AGE_SEC) {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: `latest DEWS signal is ${ageSec}s old`,
        metadata,
      };
    }
    return { status: "ok" as const, severity: "info" as const, metadata };
  } catch (error) {
    return unavailableResult(error);
  }
}

async function checkReportCardCacheMethodology(db: D1Database) {
  const cache = await loadReportCardCache(db, {
    maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS,
    requireCompleteness: true,
  });
  if (cache.kind === "error") {
    const severity: CanaryRunSeverity = cache.reason === "generation-mismatch"
      || cache.reason === "methodology-mismatch"
      || cache.reason === "identity-missing"
      || cache.reason === "identity-mismatch"
      || cache.reason === "completeness-missing"
      || cache.reason === "completeness-mismatch"
      ? "error"
      : "warning";
    return {
      status: severity === "error" ? "error" as const : "degraded" as const,
      severity,
      error: `report-card cache ${cache.reason}`,
      metadata: {
        reason: cache.reason,
        updatedAt: cache.updatedAt,
        expectedGeneration: REPORT_CARD_CACHE_GENERATION,
        maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS,
      },
    };
  }
  if (!isCurrentSafetyScoreV8Identity(cache.payload.safetyScoreIdentity)) {
    return {
      status: "error" as const,
      severity: "error" as const,
      error: "report-card cache identity-mismatch",
      metadata: {
        reason: "identity-mismatch",
        updatedAt: cache.updatedAt,
        safetyScoreIdentity: cache.payload.safetyScoreIdentity ?? null,
        expectedGeneration: REPORT_CARD_CACHE_GENERATION,
        maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS,
      },
    };
  }
  const scoreCount = Object.keys(cache.payload.scores).length;
  const metadata = {
    updatedAt: cache.updatedAt,
    scoreCount,
    methodologyVersion: cache.payload.methodologyVersion,
    safetyScoreIdentity: cache.payload.safetyScoreIdentity,
    expectedGeneration: REPORT_CARD_CACHE_GENERATION,
    maxAgeMs: REPORT_CARD_CACHE_MAX_AGE_MS,
    degradedInputs: cache.payload.degradedInputs ?? null,
  };
  if (scoreCount === 0) {
    return {
      status: "degraded" as const,
      severity: "warning" as const,
      error: "report-card cache has no score entries",
      metadata,
    };
  }
  return { status: "ok" as const, severity: "info" as const, metadata };
}

async function checkGbpBenchmarkCurrent(db: D1Database, observedAt: number) {
  try {
    const ratesCache = await getCache(db, "risk_free_rates");
    if (!ratesCache) {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: "risk-free benchmark registry cache is missing",
        metadata: { requiredFreshPublications: 2 },
      };
    }
    const registry = parseRiskFreeRatesCache(ratesCache.value, ratesCache.updatedAt, observedAt);
    const gbp = registry?.GBP ?? null;
    const streakCache = await getCache(db, GBP_BENCHMARK_FRESH_STREAK_CACHE_KEY);
    const streak = parseObjectMetadata(streakCache?.value ?? null);
    const consecutiveFreshRuns = typeof streak?.consecutiveFreshRuns === "number"
      && Number.isFinite(streak.consecutiveFreshRuns)
      ? Math.max(0, Math.floor(streak.consecutiveFreshRuns))
      : 0;
    const fetchedAgeSec = gbp?.fetchedAt != null ? Math.max(0, observedAt - gbp.fetchedAt) : null;
    const recordDateMs = gbp?.recordDate ? Date.parse(`${gbp.recordDate}T00:00:00Z`) : Number.NaN;
    const recordAgeSec = Number.isFinite(recordDateMs)
      ? Math.max(0, observedAt - Math.floor(recordDateMs / 1000))
      : null;
    const metadata = {
      source: gbp?.source ?? null,
      recordDate: gbp?.recordDate ?? null,
      fetchedAt: gbp?.fetchedAt ?? null,
      fetchedAgeSec,
      recordAgeSec,
      maxFetchAgeSec: GBP_BENCHMARK_MAX_FETCH_AGE_SEC,
      maxRecordAgeSec: GBP_BENCHMARK_MAX_RECORD_AGE_SEC,
      isFallback: gbp?.isFallback ?? null,
      fallbackMode: gbp?.fallbackMode ?? null,
      consecutiveFreshRuns,
      requiredFreshPublications: 2,
    };
    const problems: string[] = [];
    if (!gbp) problems.push("GBP benchmark is missing");
    if (gbp?.isFallback) problems.push(`GBP benchmark is fallback (${gbp.fallbackMode ?? "unknown"})`);
    if (fetchedAgeSec == null || fetchedAgeSec > GBP_BENCHMARK_MAX_FETCH_AGE_SEC) {
      problems.push("GBP benchmark fetch is stale");
    }
    if (recordAgeSec == null || recordAgeSec > GBP_BENCHMARK_MAX_RECORD_AGE_SEC) {
      problems.push("GBP benchmark observation is stale");
    }
    if (consecutiveFreshRuns < 2) {
      problems.push(`GBP benchmark has ${consecutiveFreshRuns}/2 consecutive fresh publications`);
    }
    if (problems.length > 0) {
      return {
        status: "degraded" as const,
        severity: "warning" as const,
        error: problems.join("; "),
        metadata,
      };
    }
    return { status: "ok" as const, severity: "info" as const, metadata };
  } catch (error) {
    return unavailableResult(error);
  }
}

const CANARY_CHECKS: readonly CanaryCheckDefinition[] = [
  {
    checkId: "dex-liquidity-current-publication",
    label: "DEX liquidity current publication",
    description: "Current DEX rows are published and match the latest published generation row count.",
    run: checkDexCurrentPublication,
  },
  {
    checkId: "dex-liquidity-global-row",
    label: "DEX liquidity global row",
    description: "The published DEX current table has exactly one __global__ aggregate row when data exists.",
    run: checkDexGlobalRow,
  },
  {
    checkId: "stablecoins-cache-active-count",
    label: "Stablecoins cache active count",
    description: "The stablecoins cache contains every active registry asset or an owned unexpired waiver.",
    run: checkStablecoinsCacheActiveCount,
  },
  {
    checkId: "psi-latest-sample",
    label: "PSI latest sample",
    description: "The latest PSI sample exists, is fresh, and has a finite score in the 0-100 range.",
    run: checkPsiLatestSample,
  },
  {
    checkId: "dews-latest-signal",
    label: "DEWS latest signal",
    description: "DEWS latest stress-signal rows exist, are fresh, and have scores in the 0-100 range.",
    run: checkDewsLatestSignal,
  },
  {
    checkId: "report-card-cache-methodology",
    label: "Report-card cache methodology",
    description: "The report-card score cache is fresh and matches the expected generation/methodology contract.",
    run: checkReportCardCacheMethodology,
  },
  {
    checkId: "yield-gbp-benchmark-current",
    label: "Yield GBP benchmark current",
    description: "GBP SONIA is direct, current, and has published successfully in two consecutive daily generations.",
    run: checkGbpBenchmarkCurrent,
  },
] as const;

async function runOneCanaryCheck(
  db: D1Database,
  definition: CanaryCheckDefinition,
  observedAt: number,
  signal?: AbortSignal,
): Promise<CanaryCheckResult> {
  throwIfAborted(signal);
  const startedAt = Date.now();
  try {
    const result = await definition.run(db, observedAt, signal);
    throwIfAborted(signal);
    return {
      checkId: definition.checkId,
      label: definition.label,
      description: definition.description,
      observedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      ...result,
      ...(result.error ? { error: boundedText(result.error) } : {}),
    };
  } catch (error) {
    throwIfAborted(signal);
    return {
      checkId: definition.checkId,
      label: definition.label,
      description: definition.description,
      status: "error",
      severity: "error",
      observedAt,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: boundedText(toErrorMessage(error)),
    };
  }
}

export async function runCanaryChecks(
  db: D1Database,
  options: RunCanaryChecksOptions = {},
): Promise<CanaryRunSummary> {
  const observedAt = options.observedAt ?? nowSec();
  const mode = options.mode ?? "shadow";
  const results: CanaryCheckResult[] = [];
  for (const definition of CANARY_CHECKS) {
    results.push(await runOneCanaryCheck(db, definition, observedAt, options.signal));
  }
  const counts = summarizeCanaryResults(results);
  return {
    mode,
    observedAt,
    totalChecks: results.length,
    ...counts,
    worstStatus: worstStatus(results),
    worstSeverity: worstSeverity(results),
    results,
  };
}

function summarizeCanaryResults(results: readonly Pick<CanaryCheckResult, "status">[]) {
  let okCount = 0;
  let degradedCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  for (const result of results) {
    if (result.status === "ok") okCount++;
    else if (result.status === "degraded") degradedCount++;
    else if (result.status === "error") errorCount++;
    else skippedCount++;
  }
  return { okCount, degradedCount, errorCount, skippedCount };
}

function canaryRunId(result: Pick<CanaryCheckResult, "checkId" | "observedAt">): string {
  return `canary:${result.checkId}:${result.observedAt}`;
}

function canaryIdempotencyKey(result: Pick<CanaryCheckResult, "checkId" | "observedAt">): string {
  return `${result.checkId}:${result.observedAt}`;
}

async function persistCanaryRun(
  db: D1Database,
  result: CanaryCheckResult,
  options: { mode?: WorkerCanaryMode } = {},
): Promise<void> {
  const metadataJson = boundedJson({
    label: result.label,
    description: result.description,
    mode: options.mode ?? "shadow",
    ...(result.metadata ?? {}),
  }, MAX_CANARY_METADATA_JSON_CHARS);
  await runWithOverloadRetry(() =>
    db
      .prepare(
        `INSERT INTO worker_canary_runs (
           id, check_id, idempotency_key, status, severity, observed_at, duration_ms, metadata_json, error, mode
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO UPDATE SET
           status = excluded.status,
           severity = excluded.severity,
           duration_ms = excluded.duration_ms,
           metadata_json = excluded.metadata_json,
           error = excluded.error,
           mode = excluded.mode`,
      )
      .bind(
        canaryRunId(result),
        result.checkId,
        canaryIdempotencyKey(result),
        result.status,
        result.severity,
        result.observedAt,
        result.durationMs,
        metadataJson,
        result.error ?? null,
        options.mode ?? "shadow",
      )
      .run(),
  );
}

export async function runAndPersistCanaryChecks(
  db: D1Database,
  options: RunCanaryChecksOptions = {},
): Promise<CanaryRunSummary> {
  const summary = await runCanaryChecks(db, options);
  for (const result of summary.results) {
    throwIfAborted(options.signal);
    await persistCanaryRun(db, result, { mode: summary.mode });
  }
  return summary;
}

export async function pruneWorkerCanaryRuns(
  db: D1Database,
  cutoffObservedAt: number,
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal);
  const result = await runWithOverloadRetry(() =>
    db
      .prepare("DELETE FROM worker_canary_runs WHERE observed_at < ?")
      .bind(cutoffObservedAt)
      .run(),
    3,
    signal,
  );
  return result.meta?.changes ?? 0;
}

function mapCanaryStatusRow(row: WorkerCanaryRunRow): CanaryStatus["checks"][string] {
  const metadata = parseObjectMetadata(row.metadata_json);
  const label = typeof metadata?.label === "string" ? metadata.label : row.check_id;
  const description = typeof metadata?.description === "string" ? metadata.description : "";
  const publicMetadata = metadata ? { ...metadata } : undefined;
  if (publicMetadata) {
    delete publicMetadata.label;
    delete publicMetadata.description;
  }
  return {
    checkId: row.check_id,
    label,
    description,
    status: row.status,
    severity: row.severity,
    observedAt: row.observed_at,
    durationMs: row.duration_ms,
    ...(publicMetadata && Object.keys(publicMetadata).length > 0 ? { metadata: publicMetadata } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}

function emptyCanaryStatus(now: number): CanaryStatus {
  return {
    checkedAt: now,
    status: "unknown",
    latestRunAt: null,
    maxAgeSec: CANARY_STATUS_MAX_AGE_SEC,
    totalChecks: 0,
    okCount: 0,
    degradedCount: 0,
    errorCount: 0,
    skippedCount: 0,
    staleCount: 0,
    checks: {},
  };
}

export async function loadCanaryStatus(
  db: D1Database,
  now = nowSec(),
  mode: WorkerCanaryMode = "off",
): Promise<CanaryStatus> {
  if (mode === "off" || mode === "shadow") return emptyCanaryStatus(now);
  const rows = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT r.check_id, r.status, r.severity, r.observed_at, r.duration_ms, r.metadata_json, r.error
           FROM worker_canary_runs r
           INNER JOIN (
             SELECT check_id, MAX(observed_at) AS observed_at
               FROM worker_canary_runs
              WHERE mode = ?
              GROUP BY check_id
           ) latest
             ON latest.check_id = r.check_id
            AND latest.observed_at = r.observed_at
          WHERE r.mode = ?
          ORDER BY r.check_id ASC`,
      )
      .bind(mode, mode)
      .all<WorkerCanaryRunRow>(),
  );

  const checks: CanaryStatus["checks"] = {};
  for (const row of rows.results ?? []) {
    checks[row.check_id] = mapCanaryStatusRow(row);
  }
  const latestRunAt = Object.values(checks).reduce<number | null>(
    (latest, check) => latest == null || check.observedAt > latest ? check.observedAt : latest,
    null,
  );
  const values = Object.values(checks);
  const staleCount = values.filter((check) => now - check.observedAt > CANARY_STATUS_MAX_AGE_SEC).length;
  const counts = summarizeCanaryResults(values);
  let status: CanaryStatus["status"];
  if (values.length === 0) {
    status = "unknown";
  } else if (staleCount > 0) {
    status = "stale";
  } else if (counts.errorCount > 0 || counts.degradedCount > 0) {
    status = "degraded";
  } else {
    status = "healthy";
  }
  return {
    checkedAt: now,
    status,
    latestRunAt,
    maxAgeSec: CANARY_STATUS_MAX_AGE_SEC,
    totalChecks: values.length,
    ...counts,
    staleCount,
    checks,
  };
}
