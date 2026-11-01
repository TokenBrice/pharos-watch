import { STATUS_YIELD_DATA_COVERAGE_WATCH } from "@shared/lib/status-thresholds";
import { runWithOverloadRetry } from "../lib/d1-overload-retry";
import { getCache, setCache } from "../lib/db-cache";
import { logWorkerEventArgs } from "../lib/structured-log";

/**
 * Operator conditions for producers whose "ok" run can still publish a
 * collapsed cohort. They share the freshness watchdog's transition, cooldown
 * and recovery machinery but live in their own section so a failed evidence
 * read keeps only these conditions pending, not every producer clock.
 */
export interface DexYieldWatchCondition {
  section: "producer-quality";
  id: string;
  label?: string;
  active: boolean;
  unknown?: boolean;
}

export interface DexYieldWatchResult {
  conditions: DexYieldWatchCondition[];
}

const YIELD_COVERAGE_STATE_KEY = "operator-watch:yield-data-coverage:v1";
const MAX_LABEL_ITEMS = 3;

interface YieldCoverageSeriesState {
  baseline: number;
  active: boolean;
}

type YieldCoverageState = Record<string, YieldCoverageSeriesState>;

interface YieldCoverageRow {
  started_at: number;
  published_ranking_count: number | null;
  published_tracked_count: number | null;
  published_opportunity_count: number | null;
  quality_reasons: string | null;
}

const YIELD_COVERAGE_SERIES = [
  { key: "rankings", label: "rankings", column: "published_ranking_count" },
  { key: "tracked", label: "yield-bearing", column: "published_tracked_count" },
  { key: "opportunity", label: "opportunity", column: "published_opportunity_count" },
] as const;

function parseYieldCoverageState(raw: string | null | undefined): YieldCoverageState | null {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || record.series == null || typeof record.series !== "object" || Array.isArray(record.series)) {
      return null;
    }
    const state: YieldCoverageState = {};
    for (const [key, value] of Object.entries(record.series as Record<string, unknown>)) {
      if (value == null || typeof value !== "object" || Array.isArray(value)) continue;
      const entry = value as Record<string, unknown>;
      if (typeof entry.baseline !== "number" || !Number.isFinite(entry.baseline) || entry.baseline <= 0) continue;
      if (typeof entry.active !== "boolean") continue;
      state[key] = { baseline: entry.baseline, active: entry.active };
    }
    return state;
  } catch {
    return null;
  }
}

function buildYieldCoverageState(state: YieldCoverageState, checkedAt: number): string {
  return JSON.stringify({ version: 1, checkedAt, series: state });
}

function parseQualityReasons(value: string | null): string[] | null {
  if (value == null) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((reason) => typeof reason === "string")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function toCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function boundedLabels(labels: readonly string[]): string {
  if (labels.length <= MAX_LABEL_ITEMS) return labels.join(", ");
  return `${labels.slice(0, MAX_LABEL_ITEMS).join(", ")} +${labels.length - MAX_LABEL_ITEMS} more`;
}

/**
 * Two consecutive published generations below the pre-event baseline. The
 * persisted pre-event baseline is what keeps a lasting step loss reported
 * instead of silently becoming the next comparison level; recovery requires
 * the latest generation back inside the budget.
 */
export async function loadYieldDataCoverageWatch(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexYieldWatchResult> {
  const unknownCoverage = (): DexYieldWatchCondition => ({
    section: "producer-quality",
    id: "yield-data-coverage",
    active: false,
    unknown: true,
  });
  const unknownFamilies = (): DexYieldWatchCondition => ({
    section: "producer-quality",
    id: "yield-supplemental-family-degraded",
    active: false,
    unknown: true,
  });

  let rows: YieldCoverageRow[];
  let stateRow: { value: string; updatedAt: number } | null;
  try {
    [rows, stateRow] = await Promise.all([
      runWithOverloadRetry(
        () =>
          db
            .prepare(
              `SELECT started_at,
                      CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceCoverage.publishedRankingCount') END AS published_ranking_count,
                      CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceCoverage.publishedYieldBearingCount') END AS published_tracked_count,
                      CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.sourceCoverage.publishedOpportunityCount') END AS published_opportunity_count,
                      CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.quality.reasons') END AS quality_reasons
                 FROM cron_runs
                WHERE job = 'sync-yield-data' AND status = 'ok'
                ORDER BY started_at DESC, id DESC
                LIMIT 2`,
            )
            .all<YieldCoverageRow>(),
        3,
        signal,
      ).then((result) => result.results ?? []),
      getCache(db, YIELD_COVERAGE_STATE_KEY, signal),
    ]);
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[operator-watch] Yield coverage evidence unavailable", error);
    return { conditions: [unknownCoverage(), unknownFamilies()] };
  }

  const latest = rows[0] ?? null;
  const previous = rows[1] ?? null;
  const state = parseYieldCoverageState(stateRow?.value);
  const familyReasons = latest ? parseQualityReasons(latest.quality_reasons) : [];
  const degradedFamilies = (familyReasons ?? [])
    .filter((reason) => reason.startsWith("yield-supplemental:family-degraded:"))
    .map((reason) => reason.slice("yield-supplemental:family-degraded:".length));
  const familyCondition: DexYieldWatchCondition = !latest
    ? { section: "producer-quality", id: "yield-supplemental-family-degraded", active: false }
    : familyReasons == null
      ? unknownFamilies()
      : {
          section: "producer-quality",
          id: "yield-supplemental-family-degraded",
          label: degradedFamilies.length > 0
            ? `sync-yield-data yield-supplemental ${boundedLabels(degradedFamilies)}`
            : undefined,
          active: degradedFamilies.length > 0,
        };

  if (latest == null || state == null) {
    return { conditions: [unknownCoverage(), familyCondition] };
  }

  const nextState: YieldCoverageState = { ...state };
  const activeSeries: string[] = [];
  let unknownSeries = false;
  for (const series of YIELD_COVERAGE_SERIES) {
    const latestCount = toCount(latest[series.column]);
    const previousCount = toCount(previous?.[series.column]);
    if (latestCount == null) {
      unknownSeries = true;
      continue;
    }
    const stored = state[series.key];
    const baseline = stored?.baseline ?? Math.max(latestCount, previousCount ?? latestCount);
    if (baseline < STATUS_YIELD_DATA_COVERAGE_WATCH.minBaselineCount) {
      nextState[series.key] = { baseline: latestCount, active: false };
      continue;
    }
    const threshold = baseline * STATUS_YIELD_DATA_COVERAGE_WATCH.dropRatio;
    const confirmedDrop = previousCount != null && latestCount < threshold && previousCount < threshold;
    const active = stored?.active === true ? latestCount < threshold : confirmedDrop;
    if (active) {
      activeSeries.push(`${series.label} ${latestCount} vs ${baseline}`);
      nextState[series.key] = { baseline, active: true };
    } else {
      nextState[series.key] = { baseline: Math.max(baseline, latestCount), active: false };
    }
  }

  const nextStateValue = buildYieldCoverageState(nextState, nowSec);
  if (buildYieldCoverageState(nextState, 0) !== buildYieldCoverageState(state, 0)) {
    try {
      await setCache(db, YIELD_COVERAGE_STATE_KEY, nextStateValue, signal);
    } catch (error) {
      logWorkerEventArgs("handler", "warn", "[operator-watch] Yield coverage baseline write failed", error);
    }
  }

  const coverageCondition: DexYieldWatchCondition = activeSeries.length > 0
    ? {
        section: "producer-quality",
        id: "yield-data-coverage",
        label: `sync-yield-data ${boundedLabels(activeSeries)} (2 runs; budget ${STATUS_YIELD_DATA_COVERAGE_WATCH.dropRatio * 100}%)`,
        active: true,
      }
    : unknownSeries
      ? unknownCoverage()
      : { section: "producer-quality", id: "yield-data-coverage", active: false };

  return { conditions: [coverageCondition, familyCondition] };
}

interface MeasuredExecutionChainSummary {
  scoreEligibleTargets: number;
  measured: number;
  failed: number;
  deferred: number;
}

interface MeasuredExecutionRunRow {
  started_at: number;
  chains_json: string | null;
}

function parseMeasuredExecutionChains(value: string | null): Record<string, MeasuredExecutionChainSummary> | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const chains: Record<string, MeasuredExecutionChainSummary> = {};
    for (const [chain, raw] of Object.entries(parsed as Record<string, unknown>)) {
      if (raw == null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      const counts = [entry.scoreEligibleTargets, entry.measured, entry.failed, entry.deferred].map(toCount);
      if (counts.some((count) => count == null)) continue;
      chains[chain] = {
        scoreEligibleTargets: counts[0]!,
        measured: counts[1]!,
        failed: counts[2]!,
        deferred: counts[3]!,
      };
    }
    return chains;
  } catch {
    return null;
  }
}

/**
 * A chain keeps score-eligible targets but publishes no measured quote in two
 * consecutive generations (~60 minutes). Any single target publishing renews
 * the lane's output clock, so the producer-staleness rule cannot see a starved
 * chain; this condition names it instead.
 */
export async function loadMeasuredExecutionChainWatch(
  db: D1Database,
  signal?: AbortSignal,
): Promise<DexYieldWatchResult> {
  const condition = (value: Omit<DexYieldWatchCondition, "section">): DexYieldWatchResult => ({
    conditions: [{ section: "producer-quality", ...value }],
  });
  let rows: MeasuredExecutionRunRow[];
  try {
    const result = await runWithOverloadRetry(
      () =>
        db
          .prepare(
            `SELECT started_at,
                    CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.chains') END AS chains_json
               FROM cron_runs
              WHERE job = 'sync-cl-exit-depth' AND status IN ('ok', 'degraded')
              ORDER BY started_at DESC, id DESC
              LIMIT 2`,
          )
          .all<MeasuredExecutionRunRow>(),
      3,
      signal,
    );
    rows = result.results ?? [];
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[operator-watch] Measured-execution chain evidence unavailable", error);
    return condition({ id: "measured-execution-chain-coverage", active: false, unknown: true });
  }

  const latest = rows[0] ?? null;
  const previous = rows[1] ?? null;
  if (latest == null || previous == null) {
    return condition({ id: "measured-execution-chain-coverage", active: false });
  }
  const latestChains = parseMeasuredExecutionChains(latest.chains_json);
  const previousChains = parseMeasuredExecutionChains(previous.chains_json);
  if (latestChains == null || previousChains == null) {
    return condition({ id: "measured-execution-chain-coverage", active: false, unknown: true });
  }
  const starved: string[] = [];
  for (const [chain, current] of Object.entries(latestChains)) {
    const prior = previousChains[chain];
    if (!prior) continue;
    if (current.scoreEligibleTargets === 0 || prior.scoreEligibleTargets === 0) continue;
    if (current.measured > 0 || prior.measured > 0) continue;
    starved.push(`${chain} 0/${current.scoreEligibleTargets}`);
  }
  starved.sort();
  return condition({
    id: "measured-execution-chain-coverage",
    label: starved.length > 0
      ? `sync-cl-exit-depth ${boundedLabels(starved)} over 2 generations`
      : undefined,
    active: starved.length > 0,
  });
}

export async function loadDexYieldWatchConditions(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DexYieldWatchResult> {
  try {
    const [yieldCoverage, measuredExecution] = await Promise.all([
      loadYieldDataCoverageWatch(db, nowSec, signal),
      loadMeasuredExecutionChainWatch(db, signal),
    ]);
    return { conditions: [...yieldCoverage.conditions, ...measuredExecution.conditions] };
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[operator-watch] Dex/yield operator evidence unavailable", error);
    return buildDexYieldWatchUnknownConditions();
  }
}

/** A failed detector read keeps prior transitions instead of reporting recovery. */
export function buildDexYieldWatchUnknownConditions(): DexYieldWatchResult {
  return {
    conditions: [
      { section: "producer-quality", id: "yield-data-coverage", active: false, unknown: true },
      { section: "producer-quality", id: "yield-supplemental-family-degraded", active: false, unknown: true },
      { section: "producer-quality", id: "measured-execution-chain-coverage", active: false, unknown: true },
    ],
  };
}
