import { executeAtomicBatch } from "../../lib/db";
import { classifyTelegramLogError, logTelegramEvent } from "../common/log";
import type { TelegramDeliveryState, TelegramJobRow } from "./jobs";
import type { TelegramJobKindHandler } from "./job-handler";

/** Jobs closed per sweep. */
const CLOSE_JOBS_LIMIT = 50;

/**
 * Broadcast jobs keep the message HTML in `payload_json` because every fan-out
 * page re-reads it. Terminal delivery rows already drop their `body`, but the
 * job row outlives the send (until retention), so the text is removed from the
 * payload at the transition that no longer needs it: fan-out completion, a
 * planning cancel, or the close that ends the job (which also scrubs payloads
 * readied before this rule). `payload_json` is NOT NULL, so remove the key, not
 * the column, and keep `scope`/`excludeChatId` for routing and `/forget`. The
 * `json_valid` guard keeps a corrupt payload from aborting the closing batch.
 */
export const CLEAR_JOB_MESSAGE_TEXT_SQL =
  "CASE WHEN json_valid(payload_json) THEN json_remove(payload_json, '$.messageHtml') ELSE payload_json END";

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
export async function sweepTelegramJobs(
  db: D1Database,
  nowSec: number,
  resolveHandler: (kind: TelegramJobRow["kind"]) => TelegramJobKindHandler | undefined,
): Promise<TelegramSweepResult> {
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
    const handler = resolveHandler(job.kind);
    if (handler?.onDone) {
      const counts = await db.prepare(
        "SELECT state, COUNT(*) AS n FROM telegram_deliveries WHERE job_id = ? GROUP BY state",
      ).bind(job.job_id).all<{ state: TelegramDeliveryState; n: number }>();
      try {
        await handler.onDone({
          db,
          job,
          payload: JSON.parse(job.payload_json) as unknown,
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
      `UPDATE telegram_jobs SET state = 'done', completed_at = ?, payload_json = ${CLEAR_JOB_MESSAGE_TEXT_SQL}
        WHERE job_id = ? AND state = 'ready'`,
    ).bind(nowSec, job.job_id).run();
    jobsDone += Number(closed.meta?.changes ?? 0);
  }
  return {
    sendingToUnknown: Number(unknown?.meta?.changes ?? 0),
    expired: Number(expired?.meta?.changes ?? 0),
    jobsDone,
  };
}
