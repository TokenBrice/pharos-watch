import { toErrorMessage } from "@shared/lib/error-utils";
/**
 * Operator CLI job: backfill-tape (no HTTP route).
 *
 * Trusted operator entry point that re-runs the same per-class projector
 * code path used by the `project-tape` cron, but with operator-supplied
 * window/limit overrides. Idempotent on `(source_table, source_row_id,
 * transition)`; safe to re-run.
 *
 * Params (querystring or JSON body, querystring wins):
 *   - class      repeatable; restricts the run to the named projector(s).
 *                Default: all v1 projectors.
 *   - since      epoch seconds; lower bound on source-row timestamp.
 *   - until      epoch seconds; upper bound on source-row timestamp.
 *   - maxRows    int; per-class scan cap (default 5000, max 50000).
 *   - dryRun     bool; compute but do not write or advance watermarks.
 *
 * The first-observation projectors (`methodology.bumped`,
 * `cemetery.entry.added`, and `lifecycle.tracked.frozen`) ignore `since`,
 * `until`, and `maxRows` since they scan static sources keyed by ID; they
 * still honor `dryRun`.
 */
import { errorResponse, jsonResponse } from "../../src/lib/api-response";
import { runAdminJob, readAdminIntegerParam } from "../../src/lib/admin-job";
import { TAPE_PROJECTOR_JOBS } from "../../src/lib/tape-projectors/registry";
import type { Projector, ProjectorOptions } from "../../src/lib/tape-projectors/types";
import { PSI_SAMPLE_PROJECTION_SQL, PSI_DAILY_HAS_REPAIR_SQL, projectPsiSample } from "../../src/lib/psi-sample-projection";
import { PSI_CONDITION_BAND_VALUES } from "@shared/types/stability-constants";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";

const DEFAULT_MAX_ROWS = 5_000;
const MAX_MAX_ROWS = 50_000;

const IGNORED_PARAMS_BY_CLASS: Record<string, readonly string[]> = {
  "methodology.bumped": ["since", "until", "maxRows"],
  "cemetery.entry.added": ["since", "until", "maxRows"],
  "lifecycle.tracked.frozen": ["since", "until", "maxRows"],
};

function readRepeatable(url: URL, key: string): string[] {
  return url.searchParams
    .getAll(key)
    .map((value) => value.trim())
    .filter(Boolean);
}

function readBoolean(url: URL, body: Record<string, unknown>, key: string): boolean {
  const raw = url.searchParams.get(key);
  if (raw != null) {
    const lowered = raw.trim().toLowerCase();
    return lowered === "true" || lowered === "1";
  }
  const bodyValue = body[key];
  if (typeof bodyValue === "boolean") return bodyValue;
  if (typeof bodyValue === "string") {
    const lowered = bodyValue.trim().toLowerCase();
    return lowered === "true" || lowered === "1";
  }
  return false;
}

async function reconcilePsiRepairs(db: D1Database, project: Projector, options: ProjectorOptions & { since: number; until: number }) {
  const { since, until, maxRows = DEFAULT_MAX_ROWS, dryRun } = options;
  const { results: marks } = await db.prepare(`
    SELECT d.computed_at, repair.key AS sample_at, repair.value AS score FROM stability_index d
    JOIN json_each(CASE WHEN json_valid(d.input_snapshot) THEN CASE
      WHEN json_extract(d.input_snapshot, '$.referenceMarketRepair.method') = 'samples'
        AND json_type(d.input_snapshot, '$.referenceMarketRepair.sampleScores') = 'object'
      THEN json_extract(d.input_snapshot, '$.referenceMarketRepair.sampleScores') END END) repair
    WHERE d.computed_at BETWEEN ? AND ? AND d.id = (
      SELECT id FROM stability_index WHERE computed_at = d.computed_at
        ORDER BY COALESCE(${PSI_DAILY_HAS_REPAIR_SQL}, 0) DESC, id DESC LIMIT 1)
      AND CAST(repair.key AS INTEGER) > ? AND CAST(repair.key AS INTEGER) <= ?
    ORDER BY CAST(repair.key AS INTEGER)`)
    .bind(bucketUnixSecondsToUtcDay(since + 1), bucketUnixSecondsToUtcDay(until), since, until)
    .all<{ computed_at: number; sample_at: string; score: number }>();
  if (marks.length === 0) return { projected: 0, pendingReason: "reviewed-sample-corrections-unavailable" };
  const first = Number(marks[0]!.sample_at);
  const last = Number(marks[marks.length - 1]!.sample_at);
  const { before, after } = (await db.prepare(`SELECT
    (SELECT MAX(stored_at) FROM stability_index_samples WHERE stored_at < ?) AS before,
    (SELECT MIN(stored_at) FROM stability_index_samples WHERE stored_at > ?) AS after`)
    .bind(first, last).first<{ before: number | null; after: number | null }>()) ?? { before: null, after: null };
  if (before == null || after == null) return { projected: 0, pendingReason: "psi-sample-pair-unavailable" };

  const { results } = await db.prepare(`${PSI_SAMPLE_PROJECTION_SQL}
    WHERE s.stored_at BETWEEN ? AND ? ORDER BY s.stored_at`).bind(before, after)
    .all<Parameters<typeof projectPsiSample>[0]>();
  const byTime = new Map(results.map((row) => [row.stored_at, row]));
  const bands = new Set<string>(PSI_CONDITION_BAND_VALUES);
  if (!byTime.has(before) || !byTime.has(after) || results.some((row) => !bands.has(projectPsiSample(row).band)) ||
      marks.some(({ sample_at, score, computed_at }) => {
        const at = Number(sample_at);
        return typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100 ||
          !Number.isSafeInteger(at) || String(at) !== sample_at || bucketUnixSecondsToUtcDay(at) !== computed_at ||
          byTime.get(at)?.corrected_score !== score;
      })) return { projected: 0, pendingReason: "psi-sample-pair-unavailable" };

  let projected = 0;
  for (let index = 1; index < results.length; index += maxRows) {
    const result = await project(db, { since: results[index - 1]!.stored_at,
      until: results[Math.min(index + maxRows - 1, results.length - 1)]!.stored_at, maxRows, dryRun });
    projected += result.projected;
  }
  return { projected, pendingReason: null };
}

export interface BackfillTapeRouteContext {
  db: D1Database;
  url: URL;
  trustedAdmin?: boolean;
  request?: Request;
}

export async function handleBackfillTape({
  db,
  url,
  request,
}: BackfillTapeRouteContext): Promise<Response> {
  return runAdminJob({ request, url, parseBody: true }, async ({ body }) => {
    const requestedClasses = readRepeatable(url, "class");

    const allowedNames = new Set(TAPE_PROJECTOR_JOBS.map((job) => job.name));
    const selectedJobs =
      requestedClasses.length === 0
        ? TAPE_PROJECTOR_JOBS
        : TAPE_PROJECTOR_JOBS.filter((job) => requestedClasses.includes(job.name));

    if (requestedClasses.length > 0) {
      const unknown = requestedClasses.filter((name) => !allowedNames.has(name));
      if (unknown.length > 0) {
        return errorResponse(400, `Unknown class(es): ${unknown.join(", ")}`);
      }
      if (selectedJobs.length === 0) {
        return errorResponse(400, "No matching tape projector classes selected");
      }
    }

    const since = readAdminIntegerParam(body, url.searchParams, "since", "query-first");
    const until = readAdminIntegerParam(body, url.searchParams, "until", "query-first");
    if (since != null && since < 0) return errorResponse(400, "Invalid since: must be epoch seconds >= 0");
    if (until != null && until < 0) return errorResponse(400, "Invalid until: must be epoch seconds >= 0");
    if (since != null && until != null && since > until) {
      return errorResponse(400, "Invalid window: since must be <= until");
    }

    const maxRowsRaw = readAdminIntegerParam(body, url.searchParams, "maxRows", "query-first") ?? DEFAULT_MAX_ROWS;
    if (maxRowsRaw < 1 || maxRowsRaw > MAX_MAX_ROWS) {
      return errorResponse(400, `Invalid maxRows: must be between 1 and ${MAX_MAX_ROWS}`);
    }

    const dryRun = readBoolean(url, body, "dryRun") || readBoolean(url, body, "dry-run");
    const reconcilePsi = readBoolean(url, body, "reconcilePsiRepairs");
    if (reconcilePsi && (since == null || until == null || requestedClasses.length !== 1 || requestedClasses[0] !== "psi.band_changed")) {
      return errorResponse(400, "reconcilePsiRepairs requires class=psi.band_changed and explicit since and until");
    }

    const options: ProjectorOptions = {
      since: since != null ? since : undefined,
      until: until != null ? until : undefined,
      maxRows: maxRowsRaw,
      dryRun,
    };

    const perClass: Record<string, number> = {};
    const ignoredParams: Record<string, readonly string[]> = {};
    for (const job of selectedJobs) {
      const ignored = IGNORED_PARAMS_BY_CLASS[job.name];
      if (ignored) ignoredParams[job.name] = ignored;
    }
    const errors: { name: string; message: string }[] = [];
    let total = 0;
    let pendingReason: string | null = null;

    for (const job of selectedJobs) {
      try {
        const result = reconcilePsi && since != null && until != null
          ? await reconcilePsiRepairs(db, job.run, { ...options, since, until })
          : await job.run(db, options);
        if ("pendingReason" in result) pendingReason = result.pendingReason;
        perClass[job.name] = result.projected;
        total += result.projected;
      } catch (err) {
        const message = toErrorMessage(err);
        perClass[job.name] = -1;
        errors.push({ name: job.name, message });
      }
    }

    return jsonResponse(
      {
        ok: errors.length === 0,
        dryRun,
        maxRows: maxRowsRaw,
        since: since ?? null,
        until: until ?? null,
        selectedClasses: selectedJobs.map((job) => job.name),
        ignoredParams,
        projected: total,
        perClass,
        ...(reconcilePsi ? { pendingReason } : {}),
        errors,
      },
      errors.length > 0 ? { status: 500 } : undefined,
    );
  });
}
