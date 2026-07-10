import { toErrorMessage } from "../lib/error-utils";
/**
 * POST /api/backfill-tape
 *
 * Admin-only operator entry point that re-runs the same per-class projector
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
 * The first-observation projectors (methodology / cemetery / lifecycle) ignore
 * `since`/`until` since they scan static sources keyed by id; they still honor
 * `dryRun`.
 */
import { errorResponse, jsonResponse } from "../lib/api-utils";
import { runAdminJob, readAdminIntegerParam } from "../lib/admin-job";
import { TAPE_PROJECTOR_JOBS } from "../cron/project-tape";
import type { ProjectorOptions } from "../lib/tape-projectors/types";

const DEFAULT_MAX_ROWS = 5_000;
const MAX_MAX_ROWS = 50_000;

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

export async function handleBackfillTape(
  db: D1Database,
  url: URL,
  trustedAdmin: boolean | undefined,
  request: Request | undefined,
): Promise<Response> {
  return runAdminJob({ request, trustedAdmin, url, parseBody: true }, async ({ body }) => {
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

    const since = readAdminIntegerParam(body, url.searchParams, "since");
    const until = readAdminIntegerParam(body, url.searchParams, "until");
    if (since != null && since < 0) return errorResponse(400, "Invalid since: must be epoch seconds >= 0");
    if (until != null && until < 0) return errorResponse(400, "Invalid until: must be epoch seconds >= 0");
    if (since != null && until != null && since > until) {
      return errorResponse(400, "Invalid window: since must be <= until");
    }

    const maxRowsRaw = readAdminIntegerParam(body, url.searchParams, "maxRows") ?? DEFAULT_MAX_ROWS;
    if (maxRowsRaw < 1 || maxRowsRaw > MAX_MAX_ROWS) {
      return errorResponse(400, `Invalid maxRows: must be between 1 and ${MAX_MAX_ROWS}`);
    }

    const dryRun = readBoolean(url, body, "dryRun") || readBoolean(url, body, "dry-run");

    const options: ProjectorOptions = {
      since: since != null ? since : undefined,
      until: until != null ? until : undefined,
      maxRows: maxRowsRaw,
      dryRun,
    };

    const perClass: Record<string, number> = {};
    const errors: { name: string; message: string }[] = [];
    let total = 0;

    for (const job of selectedJobs) {
      try {
        const result = await job.run(db, options);
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
        projected: total,
        perClass,
        errors,
      },
      errors.length > 0 ? { status: 500 } : undefined,
    );
  });
}
