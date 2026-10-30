import {
  TELEGRAM_FANOUT_MAX_PAGES_PER_RUN,
  TELEGRAM_FANOUT_PAGE_CHATS,
} from "@shared/lib/telegram-delivery-policy";
import { executeAtomicBatch } from "../../../lib/db";
import { D1_BATCH_SIZE } from "../../../lib/constants";
import { classifyTelegramLogError, logTelegramEvent } from "../../../telegram/common/log";
import {
  buildTelegramDeliveryInsertStatements,
  type TelegramDeliveryInput,
  type TelegramDeliveryState,
  type TelegramJobRow,
} from "../../../telegram/delivery/jobs";
import { TELEGRAM_JOB_KIND_HANDLERS } from "./registry";
import { applyTelegramChatCap } from "../rollup/chat-cap";
import { TelegramPresetFanoutError } from "../dispatch/telegram-preset-subscriber-store";

/** Live kinds subject to the per-chat cap at plan time (roll-ups and batches are not). */
const CAPPED_KINDS: ReadonlySet<string> = new Set(["alert", "freeze"]);

/**
 * Delivery rows per atomic batch: 6 rows per insert statement (15 binds each),
 * plus at most one overflow statement per 16 rows and the cursor advance, stays
 * under D1's 100-statement batch.
 */
const MAX_ROWS_PER_BATCH = 420;

const OPEN_PLANNING_JOB_SQL = `SELECT job_id, kind, payload_json, state, cursor, planned_count, created_at, expires_at, completed_at, error
   FROM telegram_jobs WHERE state IN ('planning', 'ready') AND state = 'planning'`;

/** Jobs closed per sweep. */
const CLOSE_JOBS_LIMIT = 50;

export interface TelegramFanoutResult {
  pages: number;
  deliveriesPlanned: number;
  suppressedDuplicate: number;
  jobsReady: number;
  jobsFailedClosed: number;
  /** Fail-closed alert pages attributed to the preset loader's failure mode. */
  presetQueryFailures: number;
  presetResolutionFailures: number;
  jobsCancelled: number;
  /** Rows held back by the per-chat cap (reported in the next roll-up). */
  cappedRows: number;
}

/** Chat-id-ordered slices of whole chats, each small enough for one batch. */
function sliceDeliveriesByChat(deliveries: readonly TelegramDeliveryInput[]): TelegramDeliveryInput[][] {
  const sorted = [...deliveries].sort((a, b) =>
    a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : (a.seq ?? 0) - (b.seq ?? 0));
  const slices: TelegramDeliveryInput[][] = [[]];
  for (let index = 0; index < sorted.length;) {
    const chatId = sorted[index]!.chatId;
    let end = index;
    while (end < sorted.length && sorted[end]!.chatId === chatId) end += 1;
    const current = slices[slices.length - 1]!;
    if (current.length > 0 && current.length + (end - index) > MAX_ROWS_PER_BATCH) slices.push([]);
    slices[slices.length - 1]!.push(...sorted.slice(index, end));
    index = end;
  }
  return slices;
}

function parsePayload(job: TelegramJobRow): unknown {
  return JSON.parse(job.payload_json) as unknown;
}

/**
 * Advance `planning` jobs one page at a time. Each page inserts its rows and
 * advances the job cursor in one atomic batch, so a crash replays at most one
 * page and the UNIQUE (job, chat, seq) key ignores the replayed rows.
 */
export async function fanOutPlanningTelegramJobs(
  db: D1Database,
  nowSec: number,
  options: { signal?: AbortSignal; softDeadlineAtMs?: number | null; maxPages?: number } = {},
): Promise<TelegramFanoutResult> {
  const result: TelegramFanoutResult = {
    pages: 0,
    deliveriesPlanned: 0,
    suppressedDuplicate: 0,
    jobsReady: 0,
    jobsFailedClosed: 0,
    presetQueryFailures: 0,
    presetResolutionFailures: 0,
    jobsCancelled: 0,
    cappedRows: 0,
  };
  const cancelled = await db.prepare(
    `UPDATE telegram_jobs SET state = 'cancelled', completed_at = ?, error = COALESCE(error, 'expired_while_planning')
      WHERE state = 'planning' AND expires_at <= ?`,
  ).bind(nowSec, nowSec).run();
  result.jobsCancelled = Number(cancelled.meta?.changes ?? 0);

  const maxPages = options.maxPages ?? TELEGRAM_FANOUT_MAX_PAGES_PER_RUN;

  // One resident job at a time, FIFO by (created_at, job_id). The frontier
  // is invocation-local: a failed or cancelled job is passed this run and
  // retried by the next one, never re-selected here. The redundant `IN`
  // matches idx_telegram_jobs_open's partial predicate so SQLite uses it.
  let frontier: { createdAt: number; jobId: string } | null = null;
  while (result.pages < maxPages) {
    if (options.signal?.aborted) return result;
    if (options.softDeadlineAtMs != null && Date.now() >= options.softDeadlineAtMs) return result;
    const job: TelegramJobRow | null = await (frontier == null
      ? db.prepare(`${OPEN_PLANNING_JOB_SQL} ORDER BY created_at ASC, job_id ASC LIMIT 1`)
      : db.prepare(`${OPEN_PLANNING_JOB_SQL} AND (created_at, job_id) > (?, ?) ORDER BY created_at ASC, job_id ASC LIMIT 1`)
        .bind(frontier.createdAt, frontier.jobId)
    ).first<TelegramJobRow>();
    if (!job) break;
    frontier = { createdAt: Number(job.created_at), jobId: job.job_id };
    const handler = TELEGRAM_JOB_KIND_HANDLERS[job.kind];
    if (!handler?.buildPage) {
      await db.prepare(
        "UPDATE telegram_jobs SET state = 'cancelled', completed_at = ?, error = 'no_fanout_builder' WHERE job_id = ? AND state = 'planning'",
      ).bind(nowSec, job.job_id).run();
      result.jobsCancelled += 1;
      continue;
    }
    let cursor = job.cursor;
    let plannedCount = Number(job.planned_count);
    const payload = parsePayload(job);
    const failClosed = async (error: unknown) => {
      // Fail closed: keep the job planning (retried next run; cancelled at expiry).
      result.jobsFailedClosed += 1;
      if (error instanceof TelegramPresetFanoutError) {
        if (error.mode === "query") result.presetQueryFailures += 1;
        else result.presetResolutionFailures += 1;
      }
      await db.prepare("UPDATE telegram_jobs SET error = ? WHERE job_id = ? AND state = 'planning'")
        .bind(classifyTelegramLogError(error), job.job_id).run();
      logTelegramEvent({
        level: "warn",
        message: "telegram job fan-out page failed closed",
        action: "telegram-job-fanout",
        module: "telegram-job-runner",
        sourceType: job.kind,
        errorClass: classifyTelegramLogError(error),
      });
    };
    pages: while (result.pages < maxPages) {
      if (options.signal?.aborted) return result;
      if (options.softDeadlineAtMs != null && Date.now() >= options.softDeadlineAtMs) return result;
      try {
        const page = await handler.buildPage({
          db,
          job,
          payload,
          cursor,
          nowSec,
          limit: TELEGRAM_FANOUT_PAGE_CHATS,
          signal: options.signal,
        });
        result.pages += 1;
        const slices = sliceDeliveriesByChat(page.deliveries);
        for (const [index, slice] of slices.entries()) {
          const last = index === slices.length - 1;
          // Slices end on a chat boundary in chat-id order, so an intermediate
          // cursor never skips a chat that has not been written yet.
          const sliceCursor = last ? page.nextCursor : slice[slice.length - 1]!.chatId;
          // Per-chat cap: rows over the cap become roll-up overflow entries in the same batch.
          const capped = CAPPED_KINDS.has(job.kind)
            ? await applyTelegramChatCap(db, { jobId: job.job_id, nowSec, deliveries: slice })
            : { admitted: slice, overflowStatements: [] as D1PreparedStatement[] };
          const inserts = buildTelegramDeliveryInsertStatements(
            db,
            { jobId: job.job_id, kind: job.kind, expiresAt: job.expires_at },
            capped.admitted,
            nowSec,
          );
          if (inserts.length + capped.overflowStatements.length + 1 > D1_BATCH_SIZE) {
            throw new RangeError(`Telegram fan-out slice for ${job.job_id} exceeds one atomic batch`);
          }
          const advance = db.prepare(
            `UPDATE telegram_jobs
                SET cursor = ?, planned_count = ?, state = ?, error = NULL
              WHERE job_id = ? AND state = 'planning' AND cursor IS ?`,
          ).bind(
            sliceCursor,
            plannedCount + capped.admitted.length,
            last && page.nextCursor == null ? "ready" : "planning",
            job.job_id,
            cursor,
          );
          const results = await executeAtomicBatch(
            db,
            [...inserts, ...capped.overflowStatements, advance],
            { returnResults: true },
          );
          if (Number(results[results.length - 1]?.meta?.changes ?? 0) === 0) {
            // Another run advanced this job first; its rows are already in place.
            break pages;
          }
          plannedCount += capped.admitted.length;
          result.cappedRows += slice.length - capped.admitted.length;
          result.deliveriesPlanned += capped.admitted.length;
          // Insert statements return the state of each row actually written.
          for (const insert of results.slice(0, inserts.length)) {
            for (const row of (insert.results ?? []) as Array<{ state?: string }>) {
              if (row.state === "suppressed_duplicate") result.suppressedDuplicate += 1;
            }
          }
          cursor = sliceCursor;
        }
        if (cursor == null) {
          result.jobsReady += 1;
          break;
        }
      } catch (error) {
        await failClosed(error);
        break;
      }
    }
  }
  return result;
}

export interface TelegramSweepResult {
  sendingToUnknown: number;
  expired: number;
  jobsDone: number;
}

/**
 * Three bounded statements plus job closing:
 * - `sending` past its claim window -> `unknown` (never auto-replayed);
 * - `pending`/`retry` past TTL -> `expired`;
 * - `ready` jobs with no open rows -> `onDone` then `done`.
 */
export async function sweepTelegramJobs(db: D1Database, nowSec: number): Promise<TelegramSweepResult> {
  const [unknown, expired] = await executeAtomicBatch(db, [
    db.prepare(
      `UPDATE telegram_deliveries
          SET state = 'unknown', done_at = ?, body = NULL, reason = 'claim_expired',
              claim_owner = NULL, claim_expires_at = NULL
        WHERE state = 'sending' AND claim_expires_at <= ?`,
    ).bind(nowSec, nowSec),
    db.prepare(
      `UPDATE telegram_deliveries
          SET state = 'expired', done_at = ?, body = NULL, reason = COALESCE(reason, 'ttl')
        WHERE state IN ('pending', 'retry') AND expires_at <= ?`,
    ).bind(nowSec, nowSec),
  ], { returnResults: true });

  const ready = await db.prepare(
    `SELECT job_id, kind, payload_json, state, cursor, planned_count, created_at, expires_at, completed_at, error
       FROM telegram_jobs j
      WHERE state = 'ready'
        AND NOT EXISTS (
          SELECT 1 FROM telegram_deliveries d
           WHERE d.job_id = j.job_id AND d.state IN ('pending', 'retry', 'sending')
        )
      ORDER BY created_at ASC
      LIMIT ${CLOSE_JOBS_LIMIT}`,
  ).all<TelegramJobRow>();
  let jobsDone = 0;
  for (const job of ready.results ?? []) {
    const handler = TELEGRAM_JOB_KIND_HANDLERS[job.kind];
    if (handler?.onDone) {
      const counts = await db.prepare(
        "SELECT state, COUNT(*) AS n FROM telegram_deliveries WHERE job_id = ? GROUP BY state",
      ).bind(job.job_id).all<{ state: TelegramDeliveryState; n: number }>();
      try {
        await handler.onDone({
          db,
          job,
          payload: parsePayload(job),
          counts: Object.fromEntries((counts.results ?? []).map((row) => [row.state, Number(row.n)])),
        });
      } catch (error) {
        logTelegramEvent({
          level: "warn",
          message: "telegram job completion hook failed; retried next sweep",
          action: "telegram-job-done",
          module: "telegram-job-runner",
          sourceType: job.kind,
          errorClass: classifyTelegramLogError(error),
        });
        continue;
      }
    }
    const closed = await db.prepare(
      "UPDATE telegram_jobs SET state = 'done', completed_at = ? WHERE job_id = ? AND state = 'ready'",
    ).bind(nowSec, job.job_id).run();
    jobsDone += Number(closed.meta?.changes ?? 0);
  }
  return {
    sendingToUnknown: Number(unknown?.meta?.changes ?? 0),
    expired: Number(expired?.meta?.changes ?? 0),
    jobsDone,
  };
}
