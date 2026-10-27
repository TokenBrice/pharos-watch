import { TELEGRAM_ALERT_POLICY, TELEGRAM_ALERT_TTL_SEC, isTelegramSnoozeActive } from "@shared/lib/telegram-delivery-policy";
import { MINI_APP_PAYLOAD_NAMES } from "@shared/lib/telegram-mini-app-payloads";
import { D1_BATCH_SIZE } from "../../../lib/constants";
import { buildInClause, chunkArray, executeAtomicBatch } from "../../../lib/db";
import { getCache, prepareCacheUpsert } from "../../../lib/db-cache";
import { parseJsonObject } from "../../../lib/json-parse";
import { logWorkerEvent } from "../../../lib/structured-log";
import {
  buildAlertReplyMarkup,
  formatConsolidatedMessage,
  splitMessage,
  type FreezeAlert,
} from "../../../telegram/common/alerts-formatting";
import { buildTelegramMiniAppUrl } from "../../../telegram/common/mini-app-url";
import {
  buildTelegramJobStatements,
  type TelegramDeliveryInput,
} from "../../../telegram/delivery/jobs";
import type { TelegramJobKindHandler, TelegramJobPage, TelegramJobPageContext } from "../jobs/registry";
import { loadRetractedFreezeAlertIds } from "../freeze/telegram-alert-freeze";
import {
  loadCoinChanges,
  loadFreezeChangesAfter,
  loadOverflowCounts,
  prepareChangeLogPrune,
  type StoredTelegramChange,
} from "./change-log";
import { coversCoin, loadRollupCoverage, type ChatRollupCoverage } from "./rollup-audience";
import { computeNetRollupChanges, formatRollupMessage, isMaterialGlobalSafetyChange, rollupDueLocalDate } from "./rollup-content";

/** Roll-up scans run at most once per bucket; 15 minutes covers half- and quarter-hour zones. */
const ROLLUP_SCAN_BUCKET_SEC = 15 * 60;
/** Chats rolled up per run; the rest stay due for the next run. */
const ROLLUP_MAX_CHATS_PER_RUN = 200;
const ROLLUP_SCAN_KEY = "telegram:rollup:last-scan-bucket";
const FREEZE_BATCH_STATE_KEY = "telegram:freeze-batch:state";

export interface TelegramRollupStepResult {
  freezeBatch: { state: "not-due" | "empty" | "queued" | "failed"; changes: number };
  rollup: {
    state: "not-due" | "preset-resolution-failed" | "failed" | "done";
    dueChats: number;
    sentChats: number;
    emptyChats: number;
    deferredChats: number;
  };
}

function isPrivateChat(chatId: string): boolean {
  return Number(chatId) > 0;
}

/** The roll-up's only button. */
export function manageAlertsMarkup(chatId: string) {
  return {
    inline_keyboard: [[isPrivateChat(chatId)
      ? { text: "Manage Alerts", web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.watchlist) } }
      : { text: "Manage Alerts", callback_data: "settings:home" }]],
  };
}

function freezeAlertFromChange(change: StoredTelegramChange): FreezeAlert | null {
  if (change.kind !== "freeze") return null;
  return {
    stablecoinId: change.stablecoinId,
    symbol: change.payload.symbol,
    eventType: change.payload.eventType,
    chainName: change.payload.chainName,
    amountUsdAtEvent: change.payload.amountUsdAtEvent,
    tapeEventId: change.payload.tapeEventId,
    sourceEventId: change.sourceKey,
  };
}

/** Group statements per chat into atomic batches without splitting one chat's set. */
async function executeGroupedBatches(db: D1Database, groups: readonly D1PreparedStatement[][]): Promise<void> {
  let batch: D1PreparedStatement[] = [];
  for (const group of groups) {
    if (batch.length > 0 && batch.length + group.length > D1_BATCH_SIZE) {
      await executeAtomicBatch(db, batch);
      batch = [];
    }
    batch.push(...group);
  }
  if (batch.length > 0) await executeAtomicBatch(db, batch);
}

/**
 * Drop freezes whose Tape claim or blacklist source was retracted, the same
 * fail-closed check live freeze deliveries get before sending.
 */
async function withoutRetractedFreezes(
  db: D1Database,
  changes: readonly StoredTelegramChange[],
): Promise<StoredTelegramChange[]> {
  const freezeKeys = changes.filter((change) => change.kind === "freeze").map((change) => change.sourceKey);
  if (freezeKeys.length === 0) return [...changes];
  const retracted = await loadRetractedFreezeAlertIds(db, freezeKeys);
  return changes.filter((change) => change.kind !== "freeze" || !retracted.has(change.sourceKey));
}

/**
 * One page of direct freeze followers for `(fromChangeId, toChangeId]`: the
 * next `limit` chats after `cursor` in chat-id order, with each selected chat's
 * alerts. Only `limit + 1` candidate ids and the selected chats' subscription
 * rows are resident, however large the audience. The continuation comes from
 * the selected ids, so a chat unsubscribed between the two reads still advances.
 */
async function loadFreezeBatchAlertsByChat(
  db: D1Database,
  range: { fromChangeId: number; toChangeId: number },
  cursor: string | null,
  limit: number,
): Promise<{ alertsByChat: Map<string, FreezeAlert[]>; nextCursor: string | null }> {
  const changes = await withoutRetractedFreezes(db, await loadFreezeChangesAfter(db, range.fromChangeId, range.toChangeId));
  const coinChunks = chunkArray(
    [...new Set(changes.map((change) => change.kind === "freeze" ? change.stablecoinId : ""))].filter(Boolean),
    90,
  );
  const pageSize = Math.max(1, limit);
  let candidates: string[] = [];
  for (const chunk of coinChunks) {
    const clause = buildInClause(chunk);
    const rows = await db.prepare(
      `SELECT DISTINCT chat_id FROM telegram_subscriptions
        WHERE alert_freeze = 1 AND stablecoin_id IN (${clause.sql}) AND chat_id > ?
        ORDER BY chat_id ASC LIMIT ?`,
    ).bind(...clause.binds, cursor ?? "", pageSize + 1).all<{ chat_id: string }>();
    candidates = [...new Set([...candidates, ...(rows.results ?? []).map((row) => row.chat_id)])].sort().slice(0, pageSize + 1);
  }
  const page = candidates.slice(0, pageSize);
  const followersByCoin = new Map<string, string[]>();
  if (page.length > 0) {
    for (const chunk of coinChunks) {
      const clause = buildInClause(chunk);
      // Exact selected ids: chats subscribing between the two reads cannot enter this page.
      const rows = await db.prepare(
        `SELECT chat_id, stablecoin_id FROM telegram_subscriptions
          WHERE alert_freeze = 1 AND stablecoin_id IN (${clause.sql})
            AND chat_id IN (SELECT value FROM json_each(?))`,
      ).bind(...clause.binds, JSON.stringify(page)).all<{ chat_id: string; stablecoin_id: string }>();
      for (const row of rows.results ?? []) {
        followersByCoin.set(row.stablecoin_id, [...(followersByCoin.get(row.stablecoin_id) ?? []), row.chat_id]);
      }
    }
  }
  const byChat = new Map<string, FreezeAlert[]>(page.map((chatId) => [chatId, []]));
  for (const change of changes) {
    const alert = freezeAlertFromChange(change);
    if (!alert) continue;
    for (const chatId of followersByCoin.get(alert.stablecoinId) ?? []) byChat.get(chatId)?.push(alert);
  }
  const alertsByChat = new Map([...byChat].filter(([, alerts]) => alerts.length > 0));
  return { alertsByChat, nextCursor: candidates.length > page.length ? page[page.length - 1]! : null };
}

export interface FreezeBatchJobPayload {
  fromChangeId: number;
  toChangeId: number;
}

/**
 * Fan-out page for a `freeze_batch` job: the next `limit` follower chats in
 * chat-id order after the cursor. Deterministic for a cursor, so a replayed
 * page re-inserts nothing (INSERT OR IGNORE on job, chat, chunk).
 */
export async function buildFreezeBatchJobPage(
  ctx: TelegramJobPageContext<FreezeBatchJobPayload>,
): Promise<TelegramJobPage> {
  const { alertsByChat, nextCursor } = await loadFreezeBatchAlertsByChat(ctx.db, ctx.payload, ctx.cursor, ctx.limit);
  const deliveries: TelegramDeliveryInput[] = [];
  for (const [chatId, freeze] of alertsByChat) {
    const alerts = { dews: [], depegTriggered: [], depegResolved: [], depegWorsening: [], safety: [], reserve: [], freeze };
    const chunks = splitMessage(formatConsolidatedMessage(alerts, { via: { presetIds: [], watchlist: true, allStablecoins: false } }));
    chunks.forEach((body, seq) => deliveries.push({
      chatId,
      seq,
      body,
      replyMarkup: buildAlertReplyMarkup(alerts, seq, { privateChat: isPrivateChat(chatId) }),
      disableWebPagePreview: true,
      coinIds: [...new Set(freeze.map((alert) => alert.stablecoinId))],
      families: ["freeze"],
    }));
  }
  return { deliveries, nextCursor };
}

export const freezeBatchJobHandler: TelegramJobKindHandler<FreezeBatchJobPayload> = {
  kind: "freeze_batch",
  buildPage: buildFreezeBatchJobPage,
};

/**
 * Hourly batch of below-threshold freezes for direct freeze followers. The
 * change-log id cursor advances in the same D1 batch as a `planning` job
 * covering that id range; the job fans out per chat on later dispatch runs,
 * so audience size never hits a D1 batch ceiling. A missing cache cursor
 * resumes from the latest freeze_batch job's range; with no job yet it starts
 * one batch interval back, so freezes logged by the detection run that
 * precedes the first batch are kept.
 * Global-only freeze opt-ins get these in the roll-up.
 */
export async function runFreezeBatch(db: D1Database, nowSec: number): Promise<TelegramRollupStepResult["freezeBatch"]> {
  const interval = TELEGRAM_ALERT_POLICY.freeze.batchIntervalSec;
  const cached = await getCache(db, FREEZE_BATCH_STATE_KEY);
  const state = cached ? parseJsonObject(cached.value, "telegram freeze batch state") : null;
  let cursor = state && Number.isSafeInteger(state.cursor) ? Number(state.cursor) : null;
  const lastAt = cursor != null && state && Number.isSafeInteger(state.lastAt) ? Number(state.lastAt) : 0;
  // The latest durable job's range is the floor: a lost or stale cache
  // cursor must never re-batch freezes a job already covered.
  const latestJob = await db.prepare(
    "SELECT MAX(CAST(json_extract(payload_json, '$.toChangeId') AS INTEGER)) AS to_change_id FROM telegram_jobs WHERE kind = 'freeze_batch'",
  ).first<{ to_change_id: number | null }>();
  const jobFloor = latestJob?.to_change_id == null ? null : Number(latestJob.to_change_id);
  if (jobFloor != null) cursor = Math.max(cursor ?? 0, jobFloor);
  if (cursor == null) {
    const seed = await db.prepare(
      "SELECT MAX(id) AS id FROM telegram_change_log WHERE kind = 'freeze' AND observed_at <= ?",
    ).bind(nowSec - interval).first<{ id: number | null }>();
    cursor = Number(seed?.id ?? 0);
  }
  if (nowSec - lastAt < interval) return { state: "not-due", changes: 0 };

  const changes = await loadFreezeChangesAfter(db, cursor);
  const nextCursor = changes.length > 0 ? changes[changes.length - 1]!.id : cursor;
  const stateWrite = prepareCacheUpsert(db, {
    key: FREEZE_BATCH_STATE_KEY, value: JSON.stringify({ cursor: nextCursor, lastAt: nowSec }), updatedAt: nowSec,
  });
  if (changes.length === 0) {
    await stateWrite.run();
    return { state: "empty", changes: 0 };
  }
  const jobStatements = await buildTelegramJobStatements(db, {
    jobId: `freeze_batch:${cursor}-${nextCursor}`,
    kind: "freeze_batch",
    payload: { fromChangeId: cursor, toChangeId: nextCursor } satisfies FreezeBatchJobPayload,
    createdAt: nowSec,
    expiresAt: nowSec + TELEGRAM_ALERT_TTL_SEC.freeze,
  });
  await executeAtomicBatch(db, [...jobStatements, stateWrite]);
  return { state: "queued", changes: changes.length };
}

interface RollupCandidateRow {
  chat_id: string;
  timezone: string | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
  alert_snooze_until_ts: number | null;
  last_rollup_local_date: string | null;
  last_rollup_at: number | null;
}

/** Delivery states that mean the chat got, or will get, the live message. */
const LIVE_DELIVERED_STATES = ["pending", "retry", "sending", "sent", "unknown"] as const;

interface LiveAlertRow {
  chat_id: string;
  coin_ids: string | null;
  families: string | null;
  job_id: string;
  kind: string;
  payload_json: string;
  created_at: number;
}

type LiveAlertedAt = Map<string, Map<string, number>>;

/** `family:coin` pairs a live job's payload alerted on. */
function liveJobFamilyCoins(kind: string, payloadJson: string): string[] {
  const payload = parseJsonObject(payloadJson, "telegram live job payload");
  if (!payload) return [];
  if (kind === "freeze") return typeof payload.stablecoinId === "string" ? [`freeze:${payload.stablecoinId}`] : [];
  const events = payload.events as Record<string, Array<{ stablecoinId?: unknown }> | undefined> | undefined;
  const pairs: string[] = [];
  for (const [family, list] of [["safety", events?.safetyChanges], ["dews", events?.dewsChanges], ["reserve", events?.reservePromoted]] as const) {
    for (const event of list ?? []) if (typeof event.stablecoinId === "string") pairs.push(`${family}:${event.stablecoinId}`);
  }
  return pairs;
}

/**
 * When each chat last got a live alert per family and coin since `sinceSec`,
 * from its delivery rows and their jobs' payloads. A live alert states the
 * coin's state at that time, so the roll-up only reports what changed after it.
 */
export async function loadLiveAlertedAt(db: D1Database, chatIds: readonly string[], sinceSec: number): Promise<LiveAlertedAt> {
  const alerted: LiveAlertedAt = new Map();
  const pairsByJob = new Map<string, string[]>();
  for (const chunk of chunkArray([...chatIds], 90)) {
    const chats = buildInClause(chunk);
    const states = buildInClause([...LIVE_DELIVERED_STATES]);
    const rows = await db.prepare(
      `SELECT d.chat_id, d.coin_ids, d.families, j.job_id, j.kind, j.payload_json, j.created_at
         FROM telegram_deliveries d
         JOIN telegram_jobs j ON j.job_id = d.job_id
        WHERE d.chat_id IN (${chats.sql}) AND d.seq = 0
          AND d.kind IN ('alert', 'freeze') AND d.state IN (${states.sql})
          AND j.created_at > ?`,
    ).bind(...chats.binds, ...states.binds, sinceSec).all<LiveAlertRow>();
    for (const row of rows.results ?? []) {
      let pairs = pairsByJob.get(row.job_id);
      if (!pairs) {
        pairs = liveJobFamilyCoins(row.kind, row.payload_json);
        pairsByJob.set(row.job_id, pairs);
      }
      // A job covers many coins and families; this chat got only the coins
      // and families on its own delivery row. Those two lists pin down the
      // delivered (family, coin) pairs only when one of them has a single
      // entry; a multi-coin, multi-family message could pair them either
      // way, so it suppresses nothing (a repeat beats a hidden change).
      const chatCoins = new Set((row.coin_ids ?? "").split(",").filter(Boolean));
      const chatFamilies = new Set((row.families ?? "").split(",").filter(Boolean));
      if (chatCoins.size > 1 && chatFamilies.size > 1) continue;
      const byPair = alerted.get(row.chat_id) ?? new Map<string, number>();
      for (const pair of pairs) {
        const separator = pair.indexOf(":");
        if (!chatCoins.has(pair.slice(separator + 1)) || !chatFamilies.has(pair.slice(0, separator))) continue;
        byPair.set(pair, Math.max(byPair.get(pair) ?? 0, Number(row.created_at)));
      }
      alerted.set(row.chat_id, byPair);
    }
  }
  return alerted;
}

function chatChanges(
  changes: readonly StoredTelegramChange[],
  coverage: ChatRollupCoverage,
  sinceSec: number,
  liveAlertedAt: ReadonlyMap<string, number> = new Map(),
): StoredTelegramChange[] {
  return changes.filter((change) => {
    if (change.kind === "overflow" || change.observedAt <= sinceSec) return false;
    // Already told live: only moves after that alert are new to this chat.
    // Global safety/DEWS is never sent live, so only a direct or preset
    // follow can have been the live delivery; a mixed message delivered
    // safety for another coin must not hide a global-only move.
    const liveAt = liveAlertedAt.get(`${change.kind}:${change.stablecoinId}`) ?? 0;
    const liveCapable = (change.kind !== "safety" && change.kind !== "dews") || coverage.coins[change.kind].has(change.stablecoinId);
    if (liveCapable && change.observedAt <= liveAt) return false;
    // Direct freeze followers already got these in the hourly batch.
    if (change.kind === "freeze") {
      return coverage.global.freeze && !coverage.coins.freeze.has(change.stablecoinId) &&
        !coverage.excluded.freeze.has(change.stablecoinId);
    }
    return coversCoin(coverage, change.kind, change.stablecoinId);
  });
}

/**
 * Daily "Changes" roll-up: once per chat per local date from the policy hour,
 * outside quiet hours and pauses. It lists the net change per followed coin
 * since the chat's previous roll-up, plus the live alerts the per-chat cap
 * held back, and is skipped when empty. The job and the chat's roll-up marker
 * commit in one batch, and the job id is per chat and local date, so a retry
 * cannot send a second roll-up.
 */
export async function runDailyRollup(db: D1Database, nowSec: number): Promise<TelegramRollupStepResult["rollup"]> {
  const result: TelegramRollupStepResult["rollup"] = { state: "done", dueChats: 0, sentChats: 0, emptyChats: 0, deferredChats: 0 };
  const rows = await db.prepare(
    `SELECT s.chat_id, s.timezone, s.quiet_hours_enabled, s.quiet_hours_start_utc, s.quiet_hours_end_utc,
            s.alert_snooze_until_ts, r.last_rollup_local_date, r.last_rollup_at
       FROM telegram_subscribers s
       LEFT JOIN telegram_rollup_state r ON r.chat_id = s.chat_id`,
  ).all<RollupCandidateRow>();
  const due: Array<{ row: RollupCandidateRow; localDate: string; sinceSec: number }> = [];
  for (const row of rows.results ?? []) {
    if (isTelegramSnoozeActive(row.alert_snooze_until_ts, nowSec)) continue;
    const localDate = rollupDueLocalDate({
      timezone: row.timezone,
      quietHoursEnabled: row.quiet_hours_enabled === 1,
      quietHoursStart: row.quiet_hours_start_utc,
      quietHoursEnd: row.quiet_hours_end_utc,
      lastRollupLocalDate: row.last_rollup_local_date,
    }, nowSec);
    if (localDate == null) continue;
    due.push({ row, localDate, sinceSec: row.last_rollup_at ?? nowSec - TELEGRAM_ALERT_POLICY.rollup.firstWindowSec });
  }
  result.dueChats = due.length;
  const batch = due.slice(0, ROLLUP_MAX_CHATS_PER_RUN);
  result.deferredChats = due.length - batch.length;
  if (batch.length === 0) return result;

  const coverage = await loadRollupCoverage(db, batch.map(({ row }) => row.chat_id), nowSec);
  if (coverage == null) return { ...result, state: "preset-resolution-failed", deferredChats: due.length };
  const minSince = Math.min(...batch.map(({ sinceSec }) => sinceSec));
  const changes = await withoutRetractedFreezes(
    db, await loadCoinChanges(db, ["safety", "dews", "freeze", "reserve"], minSince, nowSec),
  );
  const overflowCounts = await loadOverflowCounts(
    db,
    batch.map(({ row }) => row.chat_id),
    new Map(batch.map(({ row, sinceSec }) => [row.chat_id, sinceSec] as const)),
    nowSec,
  );

  const liveAlertedAt = await loadLiveAlertedAt(db, batch.map(({ row }) => row.chat_id), minSince);

  const groups: D1PreparedStatement[][] = [];
  for (const { row, localDate, sinceSec } of batch) {
    const chatId = row.chat_id;
    const chatCoverage = coverage.get(chatId);
    const net = chatCoverage
      ? computeNetRollupChanges(chatChanges(changes, chatCoverage, sinceSec, liveAlertedAt.get(chatId)))
        .filter((change) => change.kind !== "safety" || chatCoverage.coins.safety.has(change.stablecoinId) ||
          isMaterialGlobalSafetyChange(change))
      : [];
    const message = formatRollupMessage({ changes: net, overflowCount: overflowCounts.get(chatId) ?? 0 });
    const marker = db.prepare(
      `INSERT INTO telegram_rollup_state (chat_id, last_rollup_local_date, last_rollup_at) VALUES (?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET last_rollup_local_date = excluded.last_rollup_local_date,
                                          last_rollup_at = excluded.last_rollup_at`,
    ).bind(chatId, localDate, nowSec);
    if (message == null) {
      result.emptyChats++;
      groups.push([marker]);
      continue;
    }
    const chunks = splitMessage(message);
    const jobStatements = await buildTelegramJobStatements(db, {
      jobId: `rollup:${localDate}:${chatId}`,
      kind: "rollup",
      payload: { localDate, sinceSec, changes: net.length },
      createdAt: nowSec,
      expiresAt: nowSec + TELEGRAM_ALERT_TTL_SEC.safety,
      deliveries: chunks.map((body, seq) => ({
        chatId,
        seq,
        body,
        ...(seq === 0 ? { replyMarkup: manageAlertsMarkup(chatId) } : {}),
        disableWebPagePreview: true,
        coinIds: [...new Set(net.map((change) => change.stablecoinId))],
        families: [...new Set(net.map((change) => change.kind))],
      })),
    });
    result.sentChats++;
    groups.push([...jobStatements, marker]);
  }
  await executeGroupedBatches(db, groups);
  return result;
}

/**
 * Dispatcher hook: hourly freeze batch, then the daily roll-up scan (at most
 * once per 15-minute bucket), then change-log retention.
 */
export async function runTelegramRollupStep(db: D1Database, nowSec: number): Promise<TelegramRollupStepResult> {
  // The freeze batch and the roll-up are independent: one failing never blocks the other.
  let freezeBatch: TelegramRollupStepResult["freezeBatch"];
  try {
    freezeBatch = await runFreezeBatch(db, nowSec);
  } catch (error) {
    logWorkerEvent({ scope: "handler", job: "dispatch-telegram-alerts", event: "telegram_freeze_batch_failed", level: "error", message: "Telegram freeze batch failed", error });
    freezeBatch = { state: "failed", changes: 0 };
  }
  const bucket = Math.floor(nowSec / ROLLUP_SCAN_BUCKET_SEC);
  const lastBucket = await getCache(db, ROLLUP_SCAN_KEY);
  if (lastBucket?.value === String(bucket)) {
    return { freezeBatch, rollup: { state: "not-due", dueChats: 0, sentChats: 0, emptyChats: 0, deferredChats: 0 } };
  }
  let rollup: TelegramRollupStepResult["rollup"];
  try {
    rollup = await runDailyRollup(db, nowSec);
  } catch (error) {
    logWorkerEvent({ scope: "handler", job: "dispatch-telegram-alerts", event: "telegram_rollup_failed", level: "error", message: "Telegram daily roll-up failed", error });
    rollup = { state: "failed", dueChats: 0, sentChats: 0, emptyChats: 0, deferredChats: 0 };
  }
  // A failed or partial run leaves the bucket open for the next run.
  const statements = [prepareChangeLogPrune(db, nowSec)];
  if (rollup.state === "done" && rollup.deferredChats === 0) {
    statements.push(prepareCacheUpsert(db, { key: ROLLUP_SCAN_KEY, value: String(bucket), updatedAt: nowSec }));
  }
  await executeAtomicBatch(db, statements);
  return { freezeBatch, rollup };
}
