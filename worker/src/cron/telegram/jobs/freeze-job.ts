import { TELEGRAM_ALERT_POLICY, TELEGRAM_ALERT_TTL_SEC } from "@shared/lib/telegram-delivery-policy";
import { chunkArray, executeAtomicBatch } from "../../../lib/db";
import { D1_BATCH_SIZE } from "../../../lib/constants";
import { getCache, prepareCacheUpsert, setCache } from "../../../lib/db-cache";
import {
  buildAlertReplyMarkup,
  formatConsolidatedMessage,
  resolveAlertLinkPreviewOptions,
  splitMessage,
  type FreezeAlert,
} from "../../../telegram/common/alerts-formatting";
import { buildTelegramJobStatements, type TelegramDeliveryInput } from "../../../telegram/delivery/jobs";
import { emptyAlerts } from "../dispatch/dispatch-telegram-routing";
import { loadFreshFreezeAlerts } from "../freeze/telegram-alert-freeze";
import type { TelegramJobKindHandler, TelegramJobPageContext } from "./registry";
import { buildTelegramChangeLogStatements, freezeAlertsToChangeLogEntries } from "../rollup/change-log";

/** Same cursor key as the legacy outbox, so cutover neither replays nor skips Tape rows. */
export const FREEZE_CURSOR_KEY = "alert:freeze-tape-cursor";

export interface FreezeJobDetection {
  state: "stale" | "seeded" | "queued" | "idle";
  observed: number;
  jobsCreated: number;
  skippedNoAudience: number;
  /** Below the real-time threshold (or unknown amount): written to the change log for the hourly batch. */
  belowRealtimeThreshold: FreezeAlert[];
  droppedUnparsed: number;
}

/**
 * Real-time freeze alerts: destroy events, and freeze/unfreeze events whose
 * at-event amount is known and at least the policy threshold. An unknown
 * amount is never treated as large (R1); everything else is batch input.
 */
function isRealtimeFreezeAlert(event: FreezeAlert): boolean {
  if (event.eventType === "destroy") return true;
  return event.amountUsdAtEvent != null &&
    event.amountUsdAtEvent >= TELEGRAM_ALERT_POLICY.freeze.realtimeMinAmountUsd;
}

async function loadFreezeAudienceScope(db: D1Database, nowSec: number) {
  const [globalRow, stablecoinRows] = await Promise.all([
    db.prepare(
      `SELECT 1 AS present FROM telegram_subscribers
        WHERE global_alert_freeze = 1
          AND (alert_snooze_until_ts IS NULL OR alert_snooze_until_ts <= ?)
        LIMIT 1`,
    ).bind(nowSec).first<{ present: number }>(),
    db.prepare(
      `SELECT DISTINCT sub.stablecoin_id
         FROM telegram_subscriptions sub
         JOIN telegram_subscribers s ON s.chat_id = sub.chat_id
        WHERE sub.alert_freeze = 1
          AND (s.alert_snooze_until_ts IS NULL OR s.alert_snooze_until_ts <= ?)
          AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)`,
    ).bind(nowSec, nowSec).all<{ stablecoin_id: string }>(),
  ]);
  return {
    hasGlobalAudience: globalRow != null,
    stablecoinIds: new Set((stablecoinRows.results ?? []).map((row) => row.stablecoin_id)),
  };
}

/**
 * Tape freeze events after the cache cursor become one `freeze:<tapeEventId>`
 * job each. Jobs and the cursor advance commit in one batch; an event with no
 * possible audience is cursor-advanced without a job (no historical alerts for
 * later subscribers).
 */
export async function detectTelegramFreezeJobs(db: D1Database, nowSec: number): Promise<FreezeJobDetection> {
  const empty = { observed: 0, jobsCreated: 0, skippedNoAudience: 0, belowRealtimeThreshold: [], droppedUnparsed: 0 };
  const cached = await getCache(db, FREEZE_CURSOR_KEY);
  const cursor = cached && /^\d+$/.test(cached.value) ? Number(cached.value) : null;
  const loaded = await loadFreshFreezeAlerts(db, cursor, nowSec);
  if (loaded.state === "stale") return { state: "stale", ...empty };
  if (loaded.state === "unseeded") {
    if (loaded.cursor != null) await setCache(db, FREEZE_CURSOR_KEY, String(loaded.cursor));
    return { state: "seeded", ...empty };
  }

  const audience = await loadFreezeAudienceScope(db, nowSec);
  const statements: D1PreparedStatement[] = [];
  const belowRealtimeThreshold: FreezeAlert[] = [];
  let skippedNoAudience = 0;
  let jobsCreated = 0;
  for (const event of loaded.alerts) {
    if (!isRealtimeFreezeAlert(event)) {
      belowRealtimeThreshold.push(event);
      continue;
    }
    if (!audience.hasGlobalAudience && !audience.stablecoinIds.has(event.stablecoinId)) {
      skippedNoAudience += 1;
      continue;
    }
    statements.push(...await buildTelegramJobStatements(db, {
      jobId: `freeze:${event.tapeEventId}`,
      kind: "freeze",
      payload: event,
      createdAt: nowSec,
      expiresAt: nowSec + TELEGRAM_ALERT_TTL_SEC.freeze,
    }));
    jobsCreated += 1;
  }
  statements.push(...buildTelegramChangeLogStatements(db, freezeAlertsToChangeLogEntries(belowRealtimeThreshold, nowSec)));
  // A burst can exceed one D1 batch. Job and change-log inserts are INSERT OR
  // IGNORE, so they commit in bounded chunks and the cursor advance rides in the
  // last one: a crash before it replays the page as no-ops, and the cursor never
  // advances past an event whose job or change-log row was not written.
  if (loaded.cursor != null) {
    statements.push(prepareCacheUpsert(db, { key: FREEZE_CURSOR_KEY, value: String(loaded.cursor), updatedAt: nowSec }));
  }
  for (const chunk of chunkArray(statements, D1_BATCH_SIZE)) {
    await executeAtomicBatch(db, chunk);
  }
  return {
    state: jobsCreated > 0 ? "queued" : "idle",
    observed: loaded.alerts.length,
    jobsCreated,
    skippedNoAudience,
    belowRealtimeThreshold,
    droppedUnparsed: loaded.droppedUnparsed ?? 0,
  };
}

/** Source suppression wins until the send boundary: retracted claims cancel queued rows. */
export async function cancelRetractedFreezeDeliveries(db: D1Database, nowSec: number): Promise<number> {
  const retractedJobPredicate = `EXISTS (
    SELECT 1 FROM tape_events AS t
      LEFT JOIN blacklist_events AS b ON t.source_table = 'blacklist_events' AND b.id = t.source_row_id
     WHERE 'freeze:' || t.event_id = %JOB%
       AND (t.suppressed_at IS NOT NULL OR b.suppression_reason IS NOT NULL)
  )`;
  const results = await executeAtomicBatch(db, [
    db.prepare(
      `UPDATE telegram_deliveries
          SET state = 'cancelled', done_at = ?, body = NULL, reason = 'freeze-claim-retracted'
        WHERE kind = 'freeze' AND state IN ('pending', 'retry')
          AND ${retractedJobPredicate.replace("%JOB%", "telegram_deliveries.job_id")}`,
    ).bind(nowSec),
    db.prepare(
      `UPDATE telegram_jobs
          SET state = 'cancelled', completed_at = ?, error = 'freeze-claim-retracted'
        WHERE kind = 'freeze' AND state = 'planning'
          AND ${retractedJobPredicate.replace("%JOB%", "telegram_jobs.job_id")}`,
    ).bind(nowSec),
  ], { returnResults: true });
  return Number(results[0]?.meta?.changes ?? 0);
}

async function buildFreezeJobPage(
  ctx: TelegramJobPageContext<FreezeAlert>,
): Promise<{ deliveries: TelegramDeliveryInput[]; nextCursor: string | null }> {
  const event = ctx.payload;
  const rows = await ctx.db.prepare(
    `SELECT s.chat_id, COALESCE(sub.alert_freeze, 0) AS direct_freeze
       FROM telegram_subscribers s
       LEFT JOIN telegram_subscriptions sub
         ON sub.chat_id = s.chat_id AND sub.stablecoin_id = ?
      WHERE s.chat_id > ?
        AND (s.global_alert_freeze = 1 OR sub.alert_freeze = 1)
        AND (s.alert_snooze_until_ts IS NULL OR s.alert_snooze_until_ts <= ?)
        AND (sub.alert_snooze_until_ts IS NULL OR sub.alert_snooze_until_ts <= ?)
        AND NOT (COALESCE(sub.alert_freeze, 0) = 0 AND COALESCE(sub.alert_freeze_override, 0) = 1)
      ORDER BY s.chat_id ASC
      LIMIT ?`,
  ).bind(event.stablecoinId, ctx.cursor ?? "", ctx.nowSec, ctx.nowSec, ctx.limit)
    .all<{ chat_id: string; direct_freeze: number }>();
  const targets = rows.results ?? [];
  const alerts = { ...emptyAlerts(), freeze: [event] };
  const deliveries: TelegramDeliveryInput[] = [];
  for (const target of targets) {
    const directFollow = Number(target.direct_freeze) === 1;
    const html = formatConsolidatedMessage(alerts, {
      via: { presetIds: [], watchlist: directFollow, allStablecoins: !directFollow },
    });
    const privateChat = Number(target.chat_id) > 0;
    for (const [chunkIndex, chunk] of splitMessage(html).entries()) {
      const linkPreviewOptions = resolveAlertLinkPreviewOptions(alerts, chunkIndex) ?? undefined;
      deliveries.push({
        chatId: target.chat_id,
        seq: chunkIndex,
        body: chunk,
        replyMarkup: buildAlertReplyMarkup(alerts, chunkIndex, { privateChat }),
        ...(linkPreviewOptions ? { linkPreviewOptions } : {}),
        disableWebPagePreview: true,
        audience: "alert",
        coinIds: [event.stablecoinId],
        families: ["freeze"],
      });
    }
  }
  return {
    deliveries,
    nextCursor: targets.length < ctx.limit ? null : targets[targets.length - 1]!.chat_id,
  };
}

export const freezeJobHandler: TelegramJobKindHandler<FreezeAlert> = {
  kind: "freeze",
  buildPage: buildFreezeJobPage,
};
