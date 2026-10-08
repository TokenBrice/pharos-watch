/**
 * Read-only DEX acceptance archive. Run from the repository root:
 *   npx tsx worker/scripts/dex-liquidity-acceptance-capture.ts capture
 *   npx tsx worker/scripts/dex-liquidity-acceptance-capture.ts capture --from 2026-10-01 --to 2026-10-04 --out agents/dex-acceptance/2026-10-04
 *   npx tsx worker/scripts/dex-liquidity-acceptance-capture.ts report --input agents/dex-acceptance --from 2026-10-01 --to 2026-10-08
 * Recommended cadence: capture DAILY (default three-day overlap), reconcile WEEKLY.
 * cron_runs expires after seven days; a weekly-only pull has no safety margin.
 * --from/--to accept UTC dates or ISO timestamps with an explicit timezone;
 * report windows are [from,to), daily flips are bucketed by day0, not day1.
 * Capture writes query text, remote clock, raw Wrangler envelopes and failures.
 * Registry/current reads are sequential live snapshots, not an as-of transaction.
 * Missing telemetry is unavailable, not zero. This tool never writes to D1.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseStrictCliArgs, runCliEntrypoint } from "../../scripts/lib/cli-args.mjs";
import { createRemoteD1Client, sqlString } from "./lib/remote-d1";

const DAY = 86400;
const WEEK = 7 * DAY;
const JOBS = ["sync-dex-liquidity", "sync-dex-liquidity-stage", "sync-dex-discovery"] as const;
const JOB_SQL = JOBS.map(sqlString).join(",");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
type Row = Record<string, unknown>;
export interface QueryCapture {
  sql: string;
  queriedAt: string;
  rows: Row[] | null;
  rowCount: number | null;
  limit: number | null;
  truncated: boolean;
  raw: unknown;
  error: string | null;
}
export interface AcceptanceCapture {
  kind: "dex-liquidity-acceptance";
  schemaVersion: 1;
  capturedAt: string;
  capturedUnix: number;
  database: string;
  window: { from: number; to: number };
  queries: Record<string, QueryCapture>;
}
export interface CronRow extends Row {
  id: number;
  job: string;
  started_at: number;
  productive: number;
  worker_version: string | null;
  metadata: unknown;
}
export interface Distribution {
  n: number;
  unavailable: number;
  median: number | null;
  p95: number | null;
  min: number | null;
  max: number | null;
}
export interface AcceptanceReport {
  kind: "dex-liquidity-acceptance-scorecard";
  schemaVersion: 1;
  window: { from: number; to: number };
  capturedAt: string[];
  legacy: { target: string; verdict: Verdict; evidence: unknown }[];
  prospective: Row & {
    queryWindowComplete: { crons: boolean; terminalErrors: boolean; daily: boolean; priorWeek: boolean };
    allSlots: number;
    terminalErrors: CronRow[];
    missingPublicationHours: number[];
    laneDistributions: Row;
    cohorts: Row;
    daily: Row & { eligiblePairCoinDays: number; flipsPer100EligiblePairDays: number | null };
    stepped: Row[];
    hourlyReturns: Row[];
    hourlyMaterialMoves: Move[];
    hourlyBasis: string;
    unexplainedMaterialMoves: Row[];
    coverageGenerations: Row[];
    unavailableQueries: Row[];
    notes: string[];
  };
}
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const object = (value: unknown): Row => value != null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
function jsonObject(value: unknown): Row {
  if (typeof value !== "string") return object(value);
  try { return object(JSON.parse(value)); } catch { return {}; }
}
const utcDate = (unix: number): string => new Date(unix * 1000).toISOString().slice(0, 10);
const metadata = (run: CronRow): Row => jsonObject(run.metadata);
const sourceCoverage = (run: CronRow): Row => object(metadata(run).sourceCoverage);
const goodQuery = (query: QueryCapture | undefined): boolean => query != null && query.error === null && query.rows !== null && !query.truncated;

export function summarize(values: readonly unknown[]): Distribution {
  const sorted = values.map(number).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n, unavailable: values.length - n,
    median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 : null,
    p95: n ? sorted[Math.ceil(0.95 * n) - 1] : null,
    min: n ? sorted[0] : null,
    max: n ? sorted[n - 1] : null,
  };
}

/** Only the UTC date literals change from report 02 Q:pinned_flips. */
export function pinnedFlipSql(from: number, to: number, band25 = false): string {
  if (!Number.isInteger(from) || !Number.isInteger(to)) throw new Error("Query window clocks must be integer epoch seconds");
  // SAFETY: integer-validated clocks produce SQL-quoted UTC dates; band predicates are fixed literals.
  return `WITH pairs AS (
 SELECT a.stablecoin_id sid,a.snapshot_date d0,a.total_tvl_usd t0,b.total_tvl_usd t1,a.methodology_version v0,b.methodology_version v1,a.source_mix_json mix0,b.source_mix_json mix1,a.coverage_class c0,b.coverage_class c1
 FROM dex_liquidity_history a JOIN dex_liquidity_history b ON b.stablecoin_id=a.stablecoin_id AND b.snapshot_date=a.snapshot_date+86400
 WHERE a.snapshot_date BETWEEN unixepoch(${sqlString(utcDate(from))}) AND unixepoch(${sqlString(utcDate(to - DAY))}) AND a.total_tvl_usd>1000000 AND b.total_tvl_usd>1000000
) SELECT *,date(d0,'unixepoch') day0,date(d0+86400,'unixepoch') day1 FROM pairs WHERE ${band25 ? "t1>=1.25*t0 OR t1<=0.8*t0" : "t1>1.5*t0 OR t1<0.5*t0"} ORDER BY sid,d0;`;
}

export function buildCaptureQueries(from: number, to: number, clock: number): Record<string, { sql: string; limit?: number }> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || !Number.isInteger(clock)) {
    throw new Error("Query clocks must be integer epoch seconds");
  }
  const contextFrom = from - 6 * 3600;
  // SAFETY: contextFrom is derived from an integer-validated clock and a fixed integer lookback.
  const predecessorGenerationIds = `SELECT generation_id FROM dex_liquidity_publication_generations WHERE state='published' AND started_at<${contextFrom} ORDER BY started_at DESC,generation_id DESC LIMIT 1`;
  const allowedJobs = new Set<string>(JOBS);
  const previousVersionIds = JOBS.map((job) => {
    if (!allowedJobs.has(job)) throw new Error(`Unsupported DEX job: ${job}`);
    // SAFETY: job is checked against the JOBS allowlist and SQL-quoted; contextFrom is integer-derived.
    return `SELECT id FROM (SELECT id FROM cron_runs WHERE job=${sqlString(job)} AND productive=1 AND started_at<${contextFrom} ORDER BY started_at DESC,id DESC LIMIT 1)`;
  }).join(" UNION ALL ");
  const firstDay = Math.floor(from / DAY) * DAY;
  const endDay = Math.floor(to / DAY) * DAY;
  return {
    pinned_flips: { sql: pinnedFlipSql(firstDay, endDay) },
    band25: { sql: pinnedFlipSql(firstDay, endDay, true) },
    // SAFETY: firstDay/endDay are integer UTC-midnight values derived from integer-validated clocks.
    history: { sql: `SELECT stablecoin_id,snapshot_date,total_tvl_usd,liquidity_score,methodology_version,coverage_class,coverage_confidence,source_mix_json,exit_route_summary_json FROM dex_liquidity_history WHERE snapshot_date BETWEEN ${firstDay} AND ${endDay} ORDER BY snapshot_date,stablecoin_id LIMIT 25000;`, limit: 25000 },
    // SAFETY: JOB_SQL consists of SQL-quoted fixed JOBS literals; contextFrom/to are integer-derived.
    crons: { sql: `SELECT * FROM cron_runs WHERE job IN (${JOB_SQL}) AND started_at>=${contextFrom} AND started_at<${to} ORDER BY started_at,id LIMIT 5000;`, limit: 5000 },
    // SAFETY: previousVersionIds contains only allowlisted, SQL-quoted jobs and integer-validated clocks.
    previous_versions: { sql: `SELECT * FROM cron_runs WHERE id IN (${previousVersionIds}) ORDER BY job,started_at;` },
    // SAFETY: JOB_SQL consists of SQL-quoted fixed JOBS literals; from/to are integer-validated above.
    cron_errors: { sql: `SELECT * FROM cron_runs WHERE job IN (${JOB_SQL}) AND started_at>=${from} AND started_at<${to} AND (status NOT IN ('ok','degraded') OR error IS NOT NULL) ORDER BY started_at,id LIMIT 5000;`, limit: 5000 },
    // SAFETY: JOB_SQL consists of SQL-quoted fixed JOBS literals; from and DAY are integers.
    cron_retention: { sql: `SELECT job,MIN(started_at) oldest,MAX(started_at) newest,COUNT(*) n,SUM(productive=1) productive_n FROM cron_runs WHERE job IN (${JOB_SQL}) AND started_at>=${from - DAY} GROUP BY job;` },
    // SAFETY: clock is integer-validated above; age thresholds are fixed integer literals.
    health: { sql: `SELECT source,COUNT(*) AS rows,COUNT(DISTINCT stablecoin_id) AS coins,SUM(refreshed_at>${clock}-86400) AS age_lt24h,SUM(refreshed_at<=${clock}-86400 AND refreshed_at>${clock}-259200) AS age_24to72h,SUM(refreshed_at<=${clock}-259200 AND refreshed_at>${clock}-1209600) AS age_3to14d,SUM(refreshed_at<=${clock}-1209600) AS age_ge14d,SUM(refreshed_at>${clock}) AS future_rows,MIN(refreshed_at) AS oldest,MAX(refreshed_at) AS newest FROM dex_pool_registry GROUP BY source ORDER BY rows DESC;` },
    registry_identity: { sql: "WITH p AS (SELECT stablecoin_id,pool_id,COUNT(*) n FROM dex_pool_registry GROUP BY stablecoin_id,pool_id) SELECT COUNT(*) AS distinct_coin_pools,SUM(n>1) AS multisource_coin_pools,SUM(n) AS registry_rows FROM p;" },
    multisource_identities: { sql: "SELECT stablecoin_id,pool_id,COUNT(*) source_rows,GROUP_CONCAT(source) sources,MIN(refreshed_at) oldest,MAX(refreshed_at) newest FROM dex_pool_registry GROUP BY stablecoin_id,pool_id HAVING COUNT(*)>1 ORDER BY stablecoin_id,pool_id LIMIT 17000;", limit: 17000 },
    physical_pools: { sql: "SELECT COUNT(DISTINCT pool_id) distinct_pool_ids,COUNT(DISTINCT stablecoin_id) distinct_coins FROM dex_pool_registry;" },
    // SAFETY: contextFrom/to are integer-derived; predecessorGenerationIds is fixed SQL with an integer clock.
    generations: { sql: `SELECT * FROM dex_liquidity_publication_generations WHERE started_at<${to} AND (started_at>=${contextFrom} OR generation_id IN (${predecessorGenerationIds})) ORDER BY started_at,generation_id LIMIT 5000;`, limit: 5000 },
    // SAFETY: contextFrom/to are integer-derived; predecessorGenerationIds is fixed SQL with an integer clock.
    generation_rows: { sql: `SELECT r.generation_id,r.stablecoin_id,r.total_tvl_usd,r.liquidity_score,r.coverage_class,r.methodology_version,r.source_mix_json,r.updated_at,json_extract(r.score_components_json,'$.exitRouteObservationCoverage.scoreEligibleObservationCount') AS score_eligible_routes FROM dex_liquidity_run_rows r JOIN dex_liquidity_publication_generations g ON g.generation_id=r.generation_id WHERE g.state='published' AND g.started_at<${to} AND (g.started_at>=${contextFrom} OR g.generation_id IN (${predecessorGenerationIds})) ORDER BY r.updated_at,r.generation_id,r.stablecoin_id LIMIT 100000;`, limit: 100000 },
    current_coverage: { sql: "SELECT d.publication_generation_id,d.methodology_version,COUNT(*) catalog_rows,SUM(d.liquidity_score IS NOT NULL OR (d.coverage_class IS NOT NULL AND d.coverage_class!='unobserved')) observed,SUM(d.liquidity_score IS NOT NULL) rated,SUM(CASE WHEN json_extract(d.score_components_json,'$.exitRouteObservationCoverage.scoreEligibleObservationCount')>0 THEN 1 WHEN json_extract(d.score_components_json,'$.exitRouteObservationCoverage.scoreEligibleObservationCount')=0 THEN 0 ELSE NULL END) route_bearing,SUM(json_extract(d.score_components_json,'$.exitRouteObservationCoverage.scoreEligibleObservationCount') IS NULL) route_unavailable,MIN(d.updated_at) oldest,MAX(d.updated_at) newest FROM dex_liquidity d WHERE d.publication_generation_id IS NULL OR d.publication_generation_id IN (SELECT generation_id FROM dex_liquidity_publication_generations WHERE state='published') GROUP BY d.publication_generation_id,d.methodology_version;" },
  };
}

function executeCaptureQuery(sql: string, queryRaw: (sql: string) => string, limit?: number): QueryCapture {
  const queriedAt = new Date().toISOString();
  let raw: unknown = null;
  try {
    raw = JSON.parse(queryRaw(sql));
    const envelopes = Array.isArray(raw) ? raw : [raw];
    const rows: Row[] = [];
    for (const value of envelopes) {
      const envelope = object(value);
      if (envelope.success === false) throw new Error(`d1-query-failed: ${JSON.stringify(envelope.errors ?? envelope.error)}`);
      const result = Array.isArray(envelope.results) ? envelope.results
        : Array.isArray(envelope.result) ? object(envelope.result[0]).results : object(envelope.result).results;
      if (!Array.isArray(result)) throw new Error("d1-result-unavailable");
      rows.push(...result.map(object));
    }
    if (envelopes.length === 0) throw new Error("d1-envelope-unavailable");
    return { sql, queriedAt, raw, rows, rowCount: rows.length, limit: limit ?? null, truncated: limit != null && rows.length >= limit, error: null };
  } catch (error) {
    return { sql, queriedAt, raw, rows: null, rowCount: null, limit: limit ?? null, truncated: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Last capture wins, including terminal updates to a previously running invocation. */
export function mergeCronRuns(captures: readonly AcceptanceCapture[]): CronRow[] {
  const byId = new Map<number, CronRow>();
  for (const capture of [...captures].sort((a, b) => a.capturedUnix - b.capturedUnix)) {
    for (const key of ["previous_versions", "crons", "cron_errors"]) {
      for (const row of capture.queries[key]?.rows ?? []) {
        if (number(row.id) !== null && typeof row.job === "string" && number(row.started_at) !== null) byId.set(row.id as number, row as CronRow);
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.started_at - b.started_at || a.id - b.id);
}

export function stratifyRuns(runs: readonly CronRow[]) {
  const previous = new Map<string, CronRow>();
  return runs.map((run) => {
    const prior = previous.get(run.job);
    const comparable = run.productive === 1 && prior != null && typeof prior.worker_version === "string" && typeof run.worker_version === "string";
    const deployExcluded = comparable && prior!.worker_version !== run.worker_version;
    if (run.productive === 1) previous.set(run.job, run);
    return { run, deployExcluded, versionBaselineUnavailable: run.productive === 1 && !comparable };
  });
}

/** Query coverage proves retained observations only; publication gaps remain a separate metric. */
function covers(captures: readonly AcceptanceCapture[], key: string, from: number, to: number): boolean {
  let cursor = from;
  for (const capture of [...captures].filter((c) => goodQuery(c.queries[key])).sort((a, b) => a.window.from - b.window.from)) {
    if (capture.window.from > cursor) break;
    // A request older than the TTL cannot certify cron retention even if SELECT succeeded.
    if (key.startsWith("cron") && capture.window.from < capture.capturedUnix - WEEK) continue;
    cursor = Math.max(cursor, capture.window.to);
    if (cursor >= to) return true;
  }
  return false;
}

function mergeRows(captures: readonly AcceptanceCapture[], key: string, identity: (row: Row) => string): Row[] {
  const merged = new Map<string, Row>();
  for (const capture of [...captures].sort((a, b) => a.capturedUnix - b.capturedUnix)) {
    for (const row of capture.queries[key]?.rows ?? []) merged.set(identity(row), row);
  }
  return [...merged.values()];
}
const material = (prior: number, current: number): boolean => prior > 0 && (current > 1.5 * prior || current < 0.5 * prior);

export function buildInventoryTransitions(generations: readonly Row[], rows: readonly Row[]): Row[] {
  const byGeneration = new Map<unknown, Map<unknown, Row>>();
  for (const row of rows) {
    const group = byGeneration.get(row.generation_id) ?? new Map<unknown, Row>();
    group.set(row.stablecoin_id, row);
    byGeneration.set(row.generation_id, group);
  }
  const ordered = generations.filter((g) => g.state === "published").sort((a, b) => Number(a.started_at) - Number(b.started_at));
  const transitions: Row[] = [];
  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    const a = byGeneration.get(previous.generation_id);
    const b = byGeneration.get(current.generation_id);
    const at = number(current.started_at);
    const priorAt = number(previous.started_at);
    const complete = a != null && b != null && a.size === number(previous.expected_row_count) && b.size === number(current.expected_row_count);
    if (!complete || at === null || priorAt === null || at - priorAt > 90 * 60) {
      transitions.push({ generationId: current.generation_id, at, status: "unavailable", reason: !complete ? "captured-generation-incomplete" : "capture-generation-gap", changes: null });
      continue;
    }
    const changes: Row[] = [];
    for (const sid of new Set([...a.keys(), ...b.keys()])) {
      const before = a.get(sid);
      const after = b.get(sid);
      const observedBefore = before != null && (before.liquidity_score != null || (before.coverage_class != null && before.coverage_class !== "unobserved"));
      const observedAfter = after != null && (after.liquidity_score != null || (after.coverage_class != null && after.coverage_class !== "unobserved"));
      let kind: string | null = null;
      if (!before) kind = "catalog-row-new";
      else if (!after) kind = "catalog-row-missing";
      else if (observedBefore && !observedAfter) kind = "observation-missing";
      else if (!observedBefore && observedAfter) kind = "observation-new";
      else if (observedBefore && observedAfter && number(before.total_tvl_usd) === 0 && (number(after.total_tvl_usd) ?? 0) > 0) kind = "zero-to-positive";
      else if (observedBefore && observedAfter && (number(before.total_tvl_usd) ?? 0) > 0 && number(after.total_tvl_usd) === 0) kind = "positive-to-zero";
      if (kind) changes.push({ stablecoinId: sid, kind, previousTvlUsd: observedBefore ? number(before?.total_tvl_usd) : null, currentTvlUsd: observedAfter ? number(after?.total_tvl_usd) : null });
    }
    transitions.push({ generationId: current.generation_id, previousGenerationId: previous.generation_id, at, status: "ok", reason: null, changes });
  }
  return transitions;
}

export interface Move {
  stablecoinId: string;
  at: number;
  runId: number | null;
  previousTvlUsd: number;
  currentTvlUsd: number;
  method: unknown;
  build: unknown;
  basis: "generation" | "top-five-lower-bound";
  detail: Row;
}
/** Frozen prospective band: inclusive 25% asymmetric band OR $1M absolute delta. */
export function isProspectiveMaterialMove(prior: number, current: number): boolean {
  return Math.abs(current - prior) >= 1000000 || (prior > 0 && (current >= 1.25 * prior || current <= 0.8 * prior));
}

export function findHourlyReturns(moves: readonly Move[]) {
  const priorByCoin = new Map<string, Move>();
  const returns: Row[] = [];
  for (const move of [...moves].sort((a, b) => a.at - b.at)) {
    if (!material(move.previousTvlUsd, move.currentTvlUsd)) continue;
    const prior = priorByCoin.get(move.stablecoinId);
    if (prior && move.at > prior.at && move.at - prior.at <= 6 * 3600
      && (prior.currentTvlUsd - prior.previousTvlUsd) * (move.currentTvlUsd - move.previousTvlUsd) < 0
      && prior.previousTvlUsd > 0
      && Math.abs(move.previousTvlUsd / prior.currentTvlUsd - 1) <= 0.05
      && Math.abs(move.currentTvlUsd / prior.previousTvlUsd - 1) <= 0.05) {
      returns.push({ stablecoinId: move.stablecoinId, firstAt: prior.at, returnAt: move.at,
        a: prior.previousTvlUsd, b: prior.currentTvlUsd, returned: move.currentTvlUsd,
        belowOneMillion: prior.previousTvlUsd < 1000000, firstRunId: prior.runId, returnRunId: move.runId,
        methodBoundary: prior.method == null || move.method == null ? null : prior.method !== move.method,
        buildBoundary: prior.build == null || move.build == null ? null : prior.build !== move.build,
        basis: prior.basis === "generation" && move.basis === "generation" ? "generation" : "top-five-lower-bound" });
    }
    priorByCoin.set(move.stablecoinId, move);
  }
  return returns;
}

type Verdict = "PASS" | "FAIL" | "UNMEASURABLE";
function verdict(complete: boolean, pass: boolean): Verdict { return complete ? pass ? "PASS" : "FAIL" : "UNMEASURABLE"; }
function completeDistribution(dist: Distribution): boolean { return dist.n > 0 && dist.unavailable === 0; }
function skipCount(run: CronRow, reason: string): number | null {
  const dimensions = metadata(run).stagedPoolSkipDimensions;
  if (!Array.isArray(dimensions)) return null;
  let total = 0;
  for (const dimension of dimensions) {
    const row = object(dimension);
    if (row.reason === reason) {
      const count = number(row.count);
      if (count === null) return null;
      total += count;
    }
  }
  return total;
}
function cost(run: CronRow, field: string): number | null {
  const entry = object(metadata(run).d1Cost);
  return entry.coverage != null && entry.coverage !== "complete" ? null : number(entry[field]);
}

export function buildAcceptanceReport(captures: readonly AcceptanceCapture[], from: number, to: number): AcceptanceReport {
  if (!captures.length || to - from !== WEEK || from % DAY !== 0 || to % DAY !== 0) throw new Error("Report requires captures and exactly seven complete UTC days");
  const merged = mergeCronRuns(captures);
  const classified = stratifyRuns(merged);
  const inWindow = classified.filter(({ run }) => run.started_at >= from && run.started_at < to);
  const publications = inWindow.filter(({ run }) => run.job === JOBS[0] && run.productive === 1);
  const clean = publications.filter((entry) => !entry.deployExcluded && !entry.versionBaselineUnavailable).map(({ run }) => run);
  const cronComplete = covers(captures, "crons", from, to);
  const errorsComplete = covers(captures, "cron_errors", from, to);
  const cleanComplete = cronComplete && publications.length > 0 && publications.every((entry) => !entry.versionBaselineUnavailable);
  const s150 = summarize(clean.map((run) => sourceCoverage(run).coinTvlStepBaselineUnavailable === true ? null : sourceCoverage(run).coinTvlStepCount150));
  const s25 = summarize(clean.map((run) => sourceCoverage(run).coinTvlStepBaselineUnavailable === true ? null : sourceCoverage(run).coinTvlStepCount25));
  const history = mergeRows(captures, "history", (row) => `${row.stablecoin_id}:${row.snapshot_date}`);
  const byDayCoin = new Map(history.map((row) => [`${row.stablecoin_id}:${row.snapshot_date}`, row]));
  const eligible: Row[] = [];
  const dailyMoves: Row[] = [];
  for (const row of history) {
    const day = number(row.snapshot_date);
    const prior = number(row.total_tvl_usd);
    if (day === null || day < from || day >= to || prior === null) continue;
    const next = byDayCoin.get(`${row.stablecoin_id}:${day + DAY}`);
    const current = number(next?.total_tvl_usd);
    if (current === null) continue;
    const pair = { stablecoinId: row.stablecoin_id, day0: day, day1: day + DAY, previousTvlUsd: prior, currentTvlUsd: current,
      ratio: prior > 0 ? current / prior : null, method0: row.methodology_version, method1: next?.methodology_version,
      sourceMix0: row.source_mix_json, sourceMix1: next?.source_mix_json };
    if (prior > 1000000 && current > 1000000) eligible.push(pair);
    if (material(prior, current)) dailyMoves.push(pair);
  }
  const flips = mergeRows(captures, "pinned_flips", (row) => `${row.sid}:${row.d0}`).filter((row) => (number(row.d0) ?? -1) >= from && (number(row.d0) ?? Infinity) < to);
  const dailyDates = new Set(history.map((row) => row.snapshot_date));
  let allDates = true;
  for (let day = from; day <= to; day += DAY) if (!dailyDates.has(day)) allDates = false;
  const dailyComplete = covers(captures, "pinned_flips", from, to) && covers(captures, "history", from, to) && allDates;
  const registrySamples = captures.filter((c) => c.capturedUnix >= from && c.capturedUnix <= to && goodQuery(c.queries.registry_identity))
    .map((c) => ({ at: c.capturedUnix, ...c.queries.registry_identity.rows![0] }));
  const registryCounts = summarize(registrySamples.map((row) => object(row).registry_rows));
  const guards = ["nearCoverageGuard", "hardCoverageGuard", "nearValueGuard", "nearMajorCoverageGuard"];
  let guardHits = 0;
  let guardUnavailable = 0;
  for (const { run } of publications) {
    for (const guard of guards) {
      const value = sourceCoverage(run)[guard] ?? metadata(run)[guard];
      if (value === true) guardHits++;
      else if (value !== false) guardUnavailable++;
    }
  }
  const terminalErrors = inWindow.filter(({ run }) => run.error != null || !["ok", "degraded"].includes(String(run.status))).map(({ run }) => run);
  const guardErrors = terminalErrors.filter((run) => /(?:coverage|value|major.*tvl)[-_ ]guard|guard.*(?:coverage|value|tvl)/i.test(String(run.error ?? "")));
  const laneDistributions = Object.fromEntries(JOBS.map((job) => {
    const entries = inWindow.filter(({ run }) => run.job === job);
    const productive = entries.filter(({ run }) => run.productive === 1);
    const selected = productive.filter((entry) => !entry.deployExcluded && !entry.versionBaselineUnavailable).map(({ run }) => run);
    return [job, { allSlots: entries.length, productive: productive.length,
      deployExcluded: productive.filter((entry) => entry.deployExcluded).length,
      versionBaselineUnavailable: productive.filter((entry) => entry.versionBaselineUnavailable).length,
      allDurationMs: summarize(entries.map(({ run }) => run.duration_ms)),
      durationMs: summarize(selected.map((run) => run.duration_ms)),
      d1Queries: summarize(selected.map((run) => cost(run, "queries"))),
      d1RowsRead: summarize(selected.map((run) => cost(run, "rowsRead"))),
      d1RowsWritten: summarize(selected.map((run) => cost(run, "rowsWritten"))),
      d1CostEvidence: entries.map(({ run }) => ({ runId: run.id, d1Cost: metadata(run).d1Cost ?? null })),
      statuses: Object.fromEntries([...new Set(entries.map(({ run }) => String(run.status)))].map((status) => [status, entries.filter(({ run }) => run.status === status).length])) }];
  }));
  const priorClean = classified.filter(({ run, deployExcluded, versionBaselineUnavailable }) => run.started_at >= from - WEEK && run.started_at < from && run.productive === 1 && !deployExcluded && !versionBaselineUnavailable).map(({ run }) => run);
  const priorComplete = covers(captures, "crons", from - WEEK, from);
  const priorStageDuration = summarize(priorClean.filter((run) => run.job === JOBS[1]).map((run) => run.duration_ms));
  const stageDuration = laneDistributions[JOBS[1]].durationMs;
  const hourlyCost = (start: number, end: number): Distribution => {
    const values: (number | null)[] = [];
    for (let hour = start; hour < end; hour += 3600) {
      const entries = classified.filter(({ run }) => run.started_at >= hour && run.started_at < hour + 3600
        && (run.job === JOBS[0] || run.job === JOBS[1]));
      if (entries.some((entry) => entry.deployExcluded)) continue;
      const reads = entries.map(({ run }) => cost(run, "rowsRead"));
      const complete = entries.some(({ run }) => run.job === JOBS[0] && run.productive === 1)
        && entries.some(({ run }) => run.job === JOBS[1])
        && entries.every((entry) => !entry.versionBaselineUnavailable)
        && reads.every((value) => value !== null);
      values.push(complete ? reads.reduce<number>((total, value) => total + value!, 0) : null);
    }
    return summarize(values);
  };
  const priorD1 = hourlyCost(from - WEEK, from);
  const currentD1 = hourlyCost(from, to);
  const skips = clean.map((run) => skipCount(run, "duplicate_exact_identity"));
  const half = Math.floor(skips.length / 2);
  const firstSkip = summarize(skips.slice(0, half));
  const secondSkip = summarize(skips.slice(half));
  const veto = summarize(clean.map((run) => skipCount(run, "authoritative_confirmation_missing")));
  const priorVeto = summarize(priorClean.filter((run) => run.job === JOBS[0]).map((run) => skipCount(run, "authoritative_confirmation_missing")));
  const coverage = summarize(clean.map((run) => sourceCoverage(run).currentCoverage));
  const legacy = [
    { target: "≤4 daily flip coin-days/week; all attributed", verdict: flips.length > 4 ? "FAIL" as Verdict : verdict(dailyComplete && flips.length === 0, true), evidence: { flips: flips.length, dailyComplete, attribution: flips.length === 0 ? "No qualifying flips when the daily window is complete" : "Pool/root-cause reason packets require operator review; source mixes alone are not attribution", eligiblePairCoinDays: eligible.length } },
    { target: "s150 median=0 excluding deploys", verdict: verdict(cleanComplete && completeDistribution(s150), s150.median === 0), evidence: s150 },
    { target: "s150 p95≤2 excluding deploys", verdict: verdict(cleanComplete && completeDistribution(s150), s150.p95 !== null && s150.p95 <= 2), evidence: s150 },
    { target: "s25 p95≤5 excluding deploys", verdict: verdict(cleanComplete && completeDistribution(s25), s25.p95 !== null && s25.p95 <= 5), evidence: s25 },
    { target: "Stage duration within +25% prior trailing-week median", verdict: verdict(cronComplete && priorComplete && laneDistributions[JOBS[1]].versionBaselineUnavailable === 0 && classified.every((entry) => entry.run.job !== JOBS[1] || entry.run.started_at < from - WEEK || entry.run.started_at >= from || !entry.versionBaselineUnavailable) && completeDistribution(stageDuration) && completeDistribution(priorStageDuration), stageDuration.median !== null && priorStageDuration.median !== null && stageDuration.median <= priorStageDuration.median * 1.25), evidence: { current: stageDuration, prior: priorStageDuration } },
    { target: "Total D1 rows_read within +25% prior trailing-week median", verdict: verdict(cronComplete && priorComplete && completeDistribution(currentD1) && completeDistribution(priorD1), currentD1.median !== null && priorD1.median !== null && currentD1.median <= priorD1.median * 1.25), evidence: { current: currentD1, prior: priorD1, basis: "Hourly total actual complete stage + publication D1 reads, including failed/neutral invocations; first-version-change productive hours excluded; provider rowsRead never substituted" } },
    { target: "Registry rows≤17,000", verdict: verdict(completeDistribution(registryCounts), registryCounts.max !== null && registryCounts.max <= 17000), evidence: { ...registryCounts, basis: "Captured live snapshots only" } },
    { target: "duplicate_exact_identity skips falling", verdict: verdict(cleanComplete && completeDistribution(firstSkip) && completeDistribution(secondSkip), firstSkip.median !== null && secondSkip.median !== null && secondSkip.median < firstSkip.median), evidence: { firstHalf: firstSkip, secondHalf: secondSkip, basis: "Diagnostic window-half trend; lost launch checkpoint not reconstructed" } },
    { target: "authoritative_confirmation_missing ±10%", verdict: "UNMEASURABLE" as Verdict, evidence: { current: veto, prior: priorVeto, reason: "Original intended launch baseline not retained; prospective prior-week comparison is diagnostic only" } },
    { target: "Coverage278±2", verdict: verdict(cleanComplete && completeDistribution(coverage), coverage.min !== null && coverage.max !== null && coverage.min >= 276 && coverage.max <= 280), evidence: { ...coverage, basis: "Literal legacy target, not a current outage verdict" } },
    { target: "Zero guard hits", verdict: guardHits + guardErrors.length > 0 ? "FAIL" as Verdict : verdict(cronComplete && errorsComplete && publications.length > 0 && guardUnavailable === 0, true), evidence: { guardHits, terminalGuardErrors: guardErrors.length, guardUnavailable } },
  ];
  const stepped: Row[] = publications.map(({ run, deployExcluded }) => ({ runId: run.id, at: run.started_at, workerVersion: run.worker_version, deployExcluded,
    ...Object.fromEntries(["coinTvlStepCount150", "coinTvlStepCount25", "coinTvlStepIds150", "coinTvlStepIds150Omitted", "coinTvlStepIds25", "coinTvlStepIds25Omitted", "coinTvlStepTop", "coinTvlStepComparisons", "coinTvlStepMissingBaseline", "coinTvlStepMissingCurrent", "coinTvlStepBaselineUnavailable"].map((key) => [key, sourceCoverage(run)[key] ?? null])) }));
  const generationRows = mergeRows(captures, "generation_rows", (row) => `${row.generation_id}:${row.stablecoin_id}`);
  const generations = mergeRows(captures, "generations", (row) => String(row.generation_id));
  const generationById = new Map(generations.map((row) => [row.generation_id, row]));
  const runByGeneration = new Map(merged.filter((run) => run.productive === 1 && run.job === JOBS[0])
    .map((run) => [object(metadata(run).persistence).generationId, run]));
  const runMethod = (run: CronRow): unknown => metadata(run).methodologyVersion
    ?? jsonObject(generationById.get(object(metadata(run).persistence).generationId)?.metadata_json).methodologyVersion
    ?? null;
  const moves = new Map<string, Move>();
  const priorCoin = new Map<string, Row>();
  for (const row of generationRows.sort((a, b) => Number(a.updated_at) - Number(b.updated_at))) {
    const sid = String(row.stablecoin_id);
    const prior = priorCoin.get(sid);
    const currentObserved = row.liquidity_score != null || (row.coverage_class != null && row.coverage_class !== "unobserved");
    const priorObserved = prior != null && (prior.liquidity_score != null || (prior.coverage_class != null && prior.coverage_class !== "unobserved"));
    const currentTvl = currentObserved ? number(row.total_tvl_usd) : null;
    const previousTvl = priorObserved ? number(prior?.total_tvl_usd) : null;
    const at = number(row.updated_at);
    const priorAt = number(prior?.updated_at);
    if (at !== null && priorAt !== null && at > priorAt && at - priorAt <= 90 * 60 && previousTvl !== null && currentTvl !== null && isProspectiveMaterialMove(previousTvl, currentTvl)) {
      const run = runByGeneration.get(row.generation_id);
      moves.set(`${sid}:${row.generation_id}`, { stablecoinId: sid, at, runId: run?.id ?? null, previousTvlUsd: previousTvl, currentTvlUsd: currentTvl, method: row.methodology_version ?? null, build: run?.worker_version ?? null, basis: "generation", detail: { generationId: row.generation_id, previousGenerationId: prior?.generation_id, sourceMix0: prior?.source_mix_json, sourceMix1: row.source_mix_json } });
    }
    priorCoin.set(sid, row);
  }
  for (const { run } of classified.filter((entry) => entry.run.job === JOBS[0] && entry.run.productive === 1)) {
    const top = sourceCoverage(run).coinTvlStepTop;
    if (!Array.isArray(top)) continue;
    for (const value of top) {
      const entry = object(value);
      const prior = number(entry.previousTvlUsd);
      const current = number(entry.currentTvlUsd);
      if (typeof entry.stablecoinId !== "string" || prior === null || current === null || !isProspectiveMaterialMove(prior, current)) continue;
      const generationId = object(metadata(run).persistence).generationId;
      const generation = generationById.get(generationId);
      const at = number(generation?.started_at) ?? number(metadata(run).outputPublishedAt) ?? run.started_at;
      const key = `${entry.stablecoinId}:${generationId ?? at}`;
      if (!moves.has(key)) moves.set(key, { stablecoinId: entry.stablecoinId, at, runId: run.id, previousTvlUsd: prior, currentTvlUsd: current, method: runMethod(run), build: run.worker_version, basis: "top-five-lower-bound", detail: entry });
    }
  }
  const contextualMoves = [...moves.values()];
  const allMoves = contextualMoves.filter((move) => move.at >= from && move.at < to);
  const unnamedSteps = stepped.flatMap((step) => {
    const ids = [...new Set([step.coinTvlStepIds150, step.coinTvlStepIds25].flatMap((value) =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []))];
    const entries = Array.isArray(step.coinTvlStepTop) ? step.coinTvlStepTop.map(object) : [];
    return ids.filter((sid) => !entries.some((entry) => entry.stablecoinId === sid && number(entry.previousTvlUsd) !== null && number(entry.currentTvlUsd) !== null)).map((stablecoinId) => ({ stablecoinId, runId: step.runId, at: step.at, reason: "Stepped ID retained, but TVL values/root-cause packet unavailable" }));
  });
  const cohorts = Object.fromEntries([...new Set(inWindow.map(({ run }) => `${run.job}|${String(runMethod(run) ?? "unavailable")}|${run.worker_version ?? "unavailable"}`))].map((key) => {
    const entries = inWindow.filter(({ run }) => `${run.job}|${String(runMethod(run) ?? "unavailable")}|${run.worker_version ?? "unavailable"}` === key);
    return [key, { n: entries.length, productive: entries.filter(({ run }) => run.productive === 1).length, durationMs: summarize(entries.map(({ run }) => run.duration_ms)), s150: summarize(entries.filter(({ run }) => run.productive === 1).map(({ run }) => sourceCoverage(run).coinTvlStepBaselineUnavailable === true ? null : sourceCoverage(run).coinTvlStepCount150)), runIds: entries.map(({ run }) => run.id) }];
  }));
  const coverageGenerations = generations.filter((g) => Number(g.started_at) >= from && Number(g.started_at) < to).map((g) => {
    const rows = generationRows.filter((r) => r.generation_id === g.generation_id);
    const meta = jsonObject(g.metadata_json);
    const complete = g.state === "published" && number(g.expected_row_count) === rows.length && rows.length > 0;
    const assetRows = rows.filter((row) => row.stablecoin_id !== "__global__");
    const activeCatalog = number(meta.activeStablecoinCount);
    const observed = number(meta.activeMetricsCount);
    const rated = complete ? assetRows.filter((row) => number(row.liquidity_score) !== null).length : null;
    const routeBearing = complete && assetRows.every((row) => number(row.score_eligible_routes) !== null)
      ? assetRows.filter((row) => Number(row.score_eligible_routes) > 0).length : null;
    return { generationId: g.generation_id, at: g.started_at, state: g.state, method: meta.methodologyVersion ?? null,
      activeCatalog, observed, rated, routeBearing,
      observedCatalogFraction: activeCatalog != null && activeCatalog > 0 && observed != null ? observed / activeCatalog : null,
      ratedCatalogFraction: activeCatalog != null && activeCatalog > 0 && rated != null ? rated / activeCatalog : null,
      routeBearingCatalogFraction: activeCatalog != null && activeCatalog > 0 && routeBearing != null ? routeBearing / activeCatalog : null,
      capturedRows: rows.length, complete };
  });
  const publicationHours = new Set(publications.map(({ run }) => Math.floor(run.started_at / 3600)));
  const missingPublicationHours: number[] = [];
  for (let hour = from; hour < to; hour += 3600) if (!publicationHours.has(Math.floor(hour / 3600))) missingPublicationHours.push(hour);
  return { kind: "dex-liquidity-acceptance-scorecard", schemaVersion: 1, window: { from, to },
    capturedAt: captures.map((c) => c.capturedAt), legacy,
    prospective: { queryWindowComplete: { crons: cronComplete, terminalErrors: errorsComplete, daily: dailyComplete, priorWeek: priorComplete },
      allSlots: inWindow.length, terminalErrors, missingPublicationHours, laneDistributions, cohorts,
      daily: { eligiblePairCoinDays: eligible.length, eligibleCoins: new Set(eligible.map((p) => p.stablecoinId)).size,
        pairDates: new Set(eligible.map((p) => p.day0)).size, flips150: flips, steps25: eligible.filter((p) => Number(p.currentTvlUsd) >= 1.25 * Number(p.previousTvlUsd) || Number(p.currentTvlUsd) <= 0.8 * Number(p.previousTvlUsd)),
        flipsPer100EligiblePairDays: eligible.length ? flips.length / eligible.length * 100 : null,
        methodCohorts: Object.fromEntries([...new Set(eligible.map((p) => `${p.method0}→${p.method1}`))].map((key) => [key, eligible.filter((p) => `${p.method0}→${p.method1}` === key).length])) },
      stepped, hourlyReturns: findHourlyReturns(contextualMoves).filter((event) => Number(event.returnAt) >= from && Number(event.returnAt) < to), hourlyMaterialMoves: allMoves,
      inventoryTransitions: buildInventoryTransitions(generations, generationRows).filter((row) => Number(row.at) >= from && Number(row.at) < to),
      hourlyBasis: "Material moves: inclusive ≥1.25x/≤0.80x OR absolute delta ≥$1M; A→B→A uses strict >1.5x/<0.5x opposite steps, ≤6h and 5% bridge/return tolerance. Generation rows when retained plus censored top-five evidence; missing values/omitted IDs prevent a complete hourly census",
      unexplainedMaterialMoves: [...allMoves.map((move) => ({ ...move, reason: "Source/protocol telemetry is not a verified root-cause reason packet" })), ...unnamedSteps, ...dailyMoves.map((move) => ({ ...move, basis: "daily", reason: "Daily source mix does not prove policy/market/operational cause" }))],
      coverageGenerations, currentCoverageSnapshots: captures.map((c) => ({ at: c.capturedUnix, rows: c.queries.current_coverage?.rows ?? null })),
      registrySamples, registryHealth: captures.map((c) => ({ at: c.capturedUnix, health: c.queries.health?.rows ?? null, identities: c.queries.registry_identity?.rows ?? null, multisourceIdentities: c.queries.multisource_identities?.rows ?? null })),
      routeEvidence: publications.map(({ run }) => ({ runId: run.id, at: run.started_at, measuredTargetFunnel: metadata(run).measuredTargetFunnel ?? null, exitRouteSelection: metadata(run).exitRouteSelection ?? null, exitRouteContinuity: metadata(run).exitRouteContinuity ?? null })),
      telemetry: publications.map(({ run }) => ({ runId: run.id, registryRowsRead: metadata(run).registryRowsRead ?? null, registryMultiSourcePools: metadata(run).registryMultiSourcePools ?? null, registryFamilyBySource: metadata(run).registryFamilyBySource ?? null, stagedPoolSkipDimensions: metadata(run).stagedPoolSkipDimensions ?? null, sourceCoverage: metadata(run).sourceCoverage ?? null })),
      unavailableQueries: captures.flatMap((c) => Object.entries(c.queries).filter(([, query]) => !goodQuery(query)).map(([key, query]) => ({ capturedAt: c.capturedAt, key, error: query.error, truncated: query.truncated }))),
      notes: ["PASS applies only to the observed retained population, never to lost history or publication availability", "Method/build boundaries are strata, not causal explanations", "No automatic policy/market/operational attribution; review the unexplained move packets", "Real d1Cost coverage=partial is unavailable for the legacy cost gate; its raw partial sums remain archived", "Safety score stability is a separate acceptance surface"] } };
}

export function renderAcceptanceMarkdown(report: AcceptanceReport): string {
  const lines = ["# DEX liquidity acceptance scorecard", "", `UTC window: ${utcDate(report.window.from)}..${utcDate(report.window.to)} (end exclusive; daily pairs use day0).`, "",
    "## Legacy handover scorecard (targets unchanged)", "", "| Handover target | Verdict | Evidence |", "| --- | --- | --- |"];
  for (const entry of report.legacy) lines.push(`| ${entry.target} | ${entry.verdict} | ${JSON.stringify(entry.evidence).replaceAll("|", "\\|")} |`);
  lines.push("", "## Prospective evidence", "", `All slots: ${report.prospective.allSlots}; terminal/non-ok rows: ${report.prospective.terminalErrors.length}; hours without observed productive publication: ${report.prospective.missingPublicationHours.length}.`,
    `Eligible pair coin-days: ${report.prospective.daily.eligiblePairCoinDays}; flips /100: ${report.prospective.daily.flipsPer100EligiblePairDays ?? "unavailable"}.`,
    `Observed A→B→A returns: ${report.prospective.hourlyReturns.length}; unexplained material packets: ${report.prospective.unexplainedMaterialMoves.length}.`,
    "", report.prospective.hourlyBasis, "", "### Duration / actual D1 cost distributions", "", "```json", JSON.stringify(report.prospective.laneDistributions, null, 2), "```",
    "", "### Active-catalog / observed / rated / score-bearing route coverage", "", "```json", JSON.stringify(report.prospective.coverageGenerations, null, 2), "```",
    "", "### Method/build-stratified cohorts (all slots)", "", "```json", JSON.stringify(report.prospective.cohorts, null, 2), "```",
    "", "### Hourly A→B→A returns (including below $1M)", "", "```json", JSON.stringify(report.prospective.hourlyReturns, null, 2), "```",
    "", "### All emitted stepped IDs, omissions and baseline availability", "", "```json", JSON.stringify(report.prospective.stepped, null, 2), "```",
    "", "### Zero / new / missing observation transitions", "", "```json", JSON.stringify(report.prospective.inventoryTransitions, null, 2), "```",
    "", "### Unexplained material moves — operator attribution required", "", "```json", JSON.stringify(report.prospective.unexplainedMaterialMoves, null, 2), "```",
    "", "### Availability / query gaps", "", "```json", JSON.stringify({ windows: report.prospective.queryWindowComplete, unavailableQueries: report.prospective.unavailableQueries, missingPublicationHours: report.prospective.missingPublicationHours }, null, 2), "```", "",
    ...report.prospective.notes.map((note) => `- ${note}`), "", "The companion JSON retains registry, route-transition, source coverage, skip and terminal-error evidence. Missing fields are null (unavailable), never a passing zero.", "");
  return lines.join("\n");
}

function readCaptures(directory: string): AcceptanceCapture[] {
  const captures: AcceptanceCapture[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) captures.push(...readCaptures(path));
    else if (entry.name.startsWith("capture-") && entry.name.endsWith(".json")) {
      const value = JSON.parse(readFileSync(path, "utf8")) as AcceptanceCapture;
      if (value.kind !== "dex-liquidity-acceptance" || value.schemaVersion !== 1) throw new Error(`Unsupported capture: ${path}`);
      captures.push(value);
    }
  }
  return captures;
}
export function parseTime(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.slice(0, 10))) {
    throw new Error("Use UTC dates or timezone-qualified ISO timestamps");
  }
  const dateOnly = value.length === 10;
  const explicitTimezone = value.endsWith("Z") || /^[+-]\d{2}:\d{2}$/.test(value.slice(-6));
  if (!dateOnly && (value[10] !== "T" || !explicitTimezone)) {
    throw new Error("Use UTC dates or timezone-qualified ISO timestamps");
  }
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`Invalid time: ${value}`);
  return Math.floor(millis / 1000);
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseStrictCliArgs(argv, { allowPositionals: true, options: {
    from: { type: "string" }, to: { type: "string" }, out: { type: "string" }, input: { type: "string" }, database: { type: "string" },
  } });
  if (values.help) { console.log("Usage: dex-liquidity-acceptance-capture.ts capture|report [--from UTC] [--to UTC] [--out DIR] [--input DIR] [--database stablecoin-db]\nCapture daily; report weekly. Defaults: capture trailing 3d; report seven complete UTC days. report recursively reads capture-*.json."); return; }
  if (positionals.length !== 1 || !["capture", "report"].includes(positionals[0])) throw new Error("Specify capture or report");
  if (positionals[0] === "capture") {
    if (values.input) throw new Error("--input belongs to report mode");
    const database = String(values.database ?? "stablecoin-db");
    const d1 = createRemoteD1Client(database);
    const clockQuery = executeCaptureQuery("SELECT datetime('now') AS captured_at, unixepoch('now') AS captured_unix, date('now','-7 days') AS window_start;", d1.queryRaw);
    const clock = number(clockQuery.rows?.[0]?.captured_unix);
    if (clock === null) throw new Error(`Remote clock unavailable: ${clockQuery.error ?? "clock-row-missing"}`);
    const to = parseTime(values.to, clock);
    const from = parseTime(values.from, to - 3 * DAY);
    if (from >= to || to > clock || to - from > WEEK) throw new Error("Capture needs an increasing past window no longer than seven days");
    const packet: AcceptanceCapture = { kind: "dex-liquidity-acceptance", schemaVersion: 1, capturedAt: new Date(clock * 1000).toISOString(), capturedUnix: clock, database, window: { from, to }, queries: { clock: clockQuery } };
    for (const [key, query] of Object.entries(buildCaptureQueries(from, to, clock))) packet.queries[key] = executeCaptureQuery(query.sql, d1.queryRaw, query.limit);
    const output = resolve(ROOT, String(values.out ?? `agents/dex-acceptance/${utcDate(clock)}`));
    mkdirSync(output, { recursive: true });
    const path = join(output, `capture-${packet.capturedAt.replaceAll(":", "-")}.json`);
    writeFileSync(path, `${JSON.stringify(packet, null, 2)}\n`, { flag: "wx" });
    console.log(path);
    if (Object.values(packet.queries).some((query) => !goodQuery(query))) throw new Error("Capture retained partial evidence; inspect unavailable/truncated queries in the packet");
  } else {
    if (values.database) throw new Error("--database belongs to capture mode");
    const input = resolve(ROOT, String(values.input ?? "agents/dex-acceptance"));
    const captures = readCaptures(input);
    if (!captures.length) throw new Error(`No captures in ${input}`);
    if (new Set(captures.map((c) => c.database)).size !== 1) throw new Error("Cannot merge different databases");
    const to = parseTime(values.to, Math.floor(Math.max(...captures.map((c) => c.capturedUnix)) / DAY) * DAY);
    const from = parseTime(values.from, to - WEEK);
    const report = buildAcceptanceReport(captures, from, to);
    const output = resolve(ROOT, String(values.out ?? input));
    mkdirSync(output, { recursive: true });
    const prefix = join(output, `scorecard-${utcDate(from)}-${utcDate(to)}`);
    writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(`${prefix}.md`, renderAcceptanceMarkdown(report));
    console.log(`${prefix}.md\n${prefix}.json`);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) runCliEntrypoint(() => main());
