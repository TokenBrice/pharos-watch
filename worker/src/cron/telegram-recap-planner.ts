/**
 * Deterministic, DB-only planner for private personalized daily recaps.
 *
 * This module deliberately never sends to Telegram and never fetches. It
 * creates exact pending payloads which the existing transport drains on the
 * following five-minute slot.
 */
import {
  TELEGRAM_RECAP_DUE_PAGE_SIZE,
  TELEGRAM_RECAP_FACT_FAMILIES,
  TELEGRAM_RECAP_FACT_TYPES,
  TELEGRAM_RECAP_FIRST_LOOKBACK_SEC,
  TELEGRAM_RECAP_LOOKBACK_SEC,
  TELEGRAM_RECAP_MAX_PAGES_PER_RUN,
  TELEGRAM_RECAP_MAX_RECIPIENTS_PER_RUN,
  TELEGRAM_RECAP_PLANNER_SOFT_DEADLINE_MS,
  TELEGRAM_RECAP_TAPE_PAGE_LIMIT,
} from "@shared/lib/telegram-recap-policy";
import {
  TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY,
  shouldPlanTelegramRecap,
  shouldQueueTelegramRecap,
  type TelegramRecapRolloutPolicy,
} from "@shared/lib/telegram-recap-rollout";
import { localDateInIanaTimezone, nextIanaLocalHourDueAt } from "@shared/lib/iana-local-time";
import type { TelegramPresetId } from "@shared/lib/telegram-presets";
import { throwIfAborted } from "../lib/abort";
import { createCronResult } from "../lib/cron-result";
import { buildInClause } from "../lib/db";
import { sha256Hex } from "../lib/hash";
import { serializePendingMarkupPolicy } from "../lib/telegram-pending-provenance";
import { listTelegramPresets, resolveTelegramPresetTargets } from "../lib/telegram-presets";
import { isPausedSentinel } from "../lib/telegram-constants";
import { formatTelegramRecap } from "../lib/telegram-recap-formatting";
import { parseTelegramRecapFacts, type TelegramRecapFact, type TelegramRecapTapeRow } from "../lib/telegram-recap-facts";
import { type TelegramRecapMembership, type TelegramRecapScopedFact } from "../lib/telegram-recap-ranking";
import {
  buildTelegramRecapDedupeKey,
  listDueTelegramRecapPreferences,
  queueTelegramRecapTarget,
  recordTelegramRecapSkip,
  type DueTelegramRecapPreference,
} from "../lib/telegram-recap-store";

/** Read one extra row so a complete fact ledger is never silently truncated. */
const TELEGRAM_RECAP_TAPE_FRESHNESS_SEC = 90 * 60;
const TELEGRAM_RECAP_STALE_SKIP_AFTER_SEC = 4 * 60 * 60;

interface ProjectTapeRunRow {
  started_at: number;
}

interface SubscriberRecapRow {
  chat_id: string;
  timezone: string | null;
  alert_snooze_until_ts: number | null;
  global_alert_dews: number;
  global_alert_depeg: number;
  global_alert_safety: number;
  global_alert_freeze: number;
}

interface DirectSubscriptionRow {
  chat_id: string;
  stablecoin_id: string;
  alert_snooze_until_ts: number | null;
}

interface PresetSubscriptionRow {
  chat_id: string;
  preset_id: string;
}

interface TapeRow extends TelegramRecapTapeRow {
  id: number;
}

interface RecipientScope {
  directCoinIds: Set<string>;
  presetCoinIds: Set<string>;
  globalFamilies: Set<TelegramRecapFact["family"]>;
  fingerprintParts: string[];
}

export interface TelegramRecapPlannerResult {
  status: "ok" | "degraded";
  itemCount: number;
  metadata: string;
}

export interface TelegramRecapPlannerOptions {
  nowSec?: number;
  maxPages?: number;
  pageSize?: number;
  /** Test-only cap override; production uses the reviewed shared fact limit. */
  tapePageLimit?: number;
  /** Test override for the cooperative wall-clock deadline. */
  softDeadlineMs?: number;
  /** Production supplies the normalized rollout policy; direct unit callers use public explicitly. */
  rolloutPolicy?: TelegramRecapRolloutPolicy;
}

function safeNowSec(options: TelegramRecapPlannerOptions): number {
  return options.nowSec ?? Math.floor(Date.now() / 1000);
}

function globalFactFamilies(row: SubscriberRecapRow): Set<TelegramRecapFact["family"]> {
  const result = new Set<TelegramRecapFact["family"]>();
  if (Number(row.global_alert_dews) === 1) result.add("dews");
  if (Number(row.global_alert_depeg) === 1) result.add("depeg");
  if (Number(row.global_alert_safety) === 1) result.add("score");
  if (Number(row.global_alert_freeze) === 1) result.add("freeze");
  return result;
}

function membershipForFact(
  scope: RecipientScope,
  fact: TelegramRecapFact,
): TelegramRecapMembership | null {
  if (scope.directCoinIds.has(fact.coinId)) return "direct";
  if (scope.presetCoinIds.has(fact.coinId)) return "preset";
  return scope.globalFamilies.has(fact.family) ? "global" : null;
}

function buildScopedFacts(scope: RecipientScope, facts: readonly TelegramRecapFact[]): TelegramRecapScopedFact[] {
  return facts.flatMap((fact) => {
    const membership = membershipForFact(scope, fact);
    return membership ? [{ ...fact, membership }] : [];
  });
}

function isPaused(row: SubscriberRecapRow): boolean {
  return isPausedSentinel(row.alert_snooze_until_ts);
}

function nextDueAtAfterLocalDateSec(
  nowSec: number,
  timezone: string,
  deliveryHourLocal: number,
  localDate: string,
): number | null {
  let cursorSec = nowSec;
  // A claimed due row can be inconsistent with the current local hour after a
  // recovery or preference repair. Skip a same-date candidate so this target
  // can never make the same immutable local date due again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const dueAtMs = nextIanaLocalHourDueAt(cursorSec * 1000, timezone, deliveryHourLocal);
    if (dueAtMs == null) return null;
    const dueLocalDate = localDateInIanaTimezone(dueAtMs, timezone);
    if (!dueLocalDate) return null;
    if (dueLocalDate > localDate) return Math.floor(dueAtMs / 1000);
    cursorSec = Math.floor(dueAtMs / 1000);
  }
  return null;
}

function recapWindow(preference: DueTelegramRecapPreference, nowSec: number): { startSec: number; endSec: number } {
  const fallbackStart = nowSec - TELEGRAM_RECAP_FIRST_LOOKBACK_SEC;
  const boundedStart = Math.max(nowSec - TELEGRAM_RECAP_LOOKBACK_SEC, preference.lastWindowEndAt ?? fallbackStart);
  return { startSec: boundedStart, endSec: nowSec };
}

function shouldRecordStaleSkip(preference: DueTelegramRecapPreference, nowSec: number): boolean {
  return nowSec - preference.expectedNextDueAt >= TELEGRAM_RECAP_STALE_SKIP_AFTER_SEC;
}

async function loadFreshProjectTapeAt(db: D1Database): Promise<number | null> {
  const row = await db.prepare(
    "SELECT started_at FROM cron_runs WHERE job = 'project-tape' AND status = 'ok' ORDER BY started_at DESC, id DESC LIMIT 1",
  ).first<ProjectTapeRunRow>();
  return row?.started_at == null ? null : Number(row.started_at);
}

async function loadSubscriberRows(db: D1Database, chatIds: readonly string[]): Promise<Map<string, SubscriberRecapRow>> {
  if (chatIds.length === 0) return new Map();
  const inClause = buildInClause(chatIds);
  const rows = await db.prepare(`
    SELECT chat_id, timezone, alert_snooze_until_ts,
           global_alert_dews, global_alert_depeg, global_alert_safety,
           global_alert_freeze
      FROM telegram_subscribers
     WHERE chat_id IN (${inClause.sql})
  `).bind(...inClause.binds).all<SubscriberRecapRow>();
  return new Map((rows.results ?? []).map((row) => [row.chat_id, row]));
}

async function loadDirectSubscriptions(
  db: D1Database,
  chatIds: readonly string[],
  nowSec: number,
): Promise<Map<string, Set<string>>> {
  if (chatIds.length === 0) return new Map();
  const inClause = buildInClause(chatIds);
  const rows = await db.prepare(`
    SELECT chat_id, stablecoin_id, alert_snooze_until_ts
      FROM telegram_subscriptions
     WHERE chat_id IN (${inClause.sql})
       AND (alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1
         OR alert_launch = 1 OR alert_reserve = 1 OR alert_freeze = 1)
  `).bind(...inClause.binds).all<DirectSubscriptionRow>();
  const result = new Map<string, Set<string>>();
  for (const row of rows.results ?? []) {
    if (row.alert_snooze_until_ts != null && Number(row.alert_snooze_until_ts) > nowSec) continue;
    const ids = result.get(row.chat_id) ?? new Set<string>();
    ids.add(row.stablecoin_id);
    result.set(row.chat_id, ids);
  }
  return result;
}

async function loadPresetSubscriptions(db: D1Database, chatIds: readonly string[]): Promise<Map<string, TelegramPresetId[]>> {
  if (chatIds.length === 0) return new Map();
  const supportedPresetIds = new Set(listTelegramPresets().map((preset) => preset.id));
  const inClause = buildInClause(chatIds);
  const rows = await db.prepare(`
    SELECT chat_id, preset_id
      FROM telegram_preset_subscriptions
     WHERE chat_id IN (${inClause.sql})
       AND (alert_dews = 1 OR alert_depeg = 1 OR alert_safety = 1)
  `).bind(...inClause.binds).all<PresetSubscriptionRow>();
  const result = new Map<string, TelegramPresetId[]>();
  for (const row of rows.results ?? []) {
    if (!supportedPresetIds.has(row.preset_id as TelegramPresetId)) continue;
    const ids = result.get(row.chat_id) ?? [];
    ids.push(row.preset_id as TelegramPresetId);
    result.set(row.chat_id, ids);
  }
  return result;
}

async function loadTapeFacts(
  db: D1Database,
  startSec: number,
  endSec: number,
  limit: number,
): Promise<{
  truncated: boolean;
  highWaterId: number | null;
  facts: TelegramRecapFact[];
  loadedCount: number;
  rejectedCount: number;
}> {
  const typeClause = buildInClause(TELEGRAM_RECAP_FACT_TYPES);
  const rows = await db.prepare(`
    SELECT id, event_id, type, severity, ts, coin_id, chain, payload_json
      FROM tape_events
     WHERE ts > ? AND ts <= ?
       AND type IN (${typeClause.sql})
     ORDER BY ts ASC, id ASC
     LIMIT ?
  `).bind(startSec * 1000, endSec * 1000, ...typeClause.binds, limit + 1).all<TapeRow>();
  const result = rows.results ?? [];
  if (result.length > limit) {
    return { truncated: true, highWaterId: null, facts: [], loadedCount: result.length, rejectedCount: 0 };
  }
  const facts = parseTelegramRecapFacts(result);
  return {
    truncated: false,
    highWaterId: result.length > 0 ? Number(result[result.length - 1]!.id) : null,
    facts,
    loadedCount: result.length,
    rejectedCount: result.length - facts.length,
  };
}

function scopeForRecipient(
  subscriber: SubscriberRecapRow,
  directByChat: ReadonlyMap<string, Set<string>>,
  presetsByChat: ReadonlyMap<string, TelegramPresetId[]>,
  presetCoinIds: ReadonlyMap<TelegramPresetId, readonly string[]>,
): RecipientScope {
  const directCoinIds = directByChat.get(subscriber.chat_id) ?? new Set<string>();
  const presetCoinIdsForChat = new Set<string>();
  const presetIds = [...new Set(presetsByChat.get(subscriber.chat_id) ?? [])].sort();
  for (const presetId of presetIds) {
    for (const coinId of presetCoinIds.get(presetId) ?? []) presetCoinIdsForChat.add(coinId);
  }
  const globalFamilies = globalFactFamilies(subscriber);
  return {
    directCoinIds,
    presetCoinIds: presetCoinIdsForChat,
    globalFamilies,
    fingerprintParts: [
      `direct:${[...directCoinIds].sort().join(",")}`,
      `presets:${presetIds.join(",")}`,
      `presetCoins:${[...presetCoinIdsForChat].sort().join(",")}`,
      `global:${[...globalFamilies].sort().join(",")}`,
    ],
  };
}

async function recordStalePage(
  db: D1Database,
  preferences: readonly DueTelegramRecapPreference[],
  subscriberByChat: ReadonlyMap<string, SubscriberRecapRow>,
  nowSec: number,
  reason: "delivery-window-expired" | "project-tape-stale",
): Promise<number> {
  let skipped = 0;
  for (const preference of preferences) {
    if (!shouldRecordStaleSkip(preference, nowSec)) continue;
    const subscriber = subscriberByChat.get(preference.chatId);
    const timezone = subscriber?.timezone;
    if (!timezone) continue;
    const localDate = localDateInIanaTimezone(preference.expectedNextDueAt * 1000, timezone);
    if (!localDate) continue;
    const nextDueAt = nextDueAtAfterLocalDateSec(
      nowSec,
      timezone,
      preference.deliveryHourLocal,
      localDate,
    );
    if (nextDueAt == null) continue;
    const window = recapWindow(preference, nowSec);
    const recapKey = buildTelegramRecapDedupeKey(preference.chatId, localDate);
    const didRecord = await recordTelegramRecapSkip(db, {
      target: {
        recapKey,
        chatId: preference.chatId,
        localDate,
        windowStartAt: window.startSec,
        windowEndAt: window.endSec,
        preferenceGeneration: preference.preferenceGeneration,
        watchlistFingerprint: "stale-input",
        nowSec,
        expectedNextDueAt: preference.expectedNextDueAt,
        nextDueAtAfter: nextDueAt,
      },
      status: "skipped_stale",
      reason,
      consumeWindow: false,
    });
    if (didRecord) skipped += 1;
  }
  return skipped;
}

/**
 * Plan up to ten deterministic recap pages. All source data comes from D1;
 * no provider client, fetch, or AI module is imported by this dependency path.
 */
export async function planTelegramPersonalizedRecaps(
  db: D1Database,
  signal?: AbortSignal,
  options: TelegramRecapPlannerOptions = {},
): Promise<TelegramRecapPlannerResult> {
  const startedAtMs = Date.now();
  const nowSec = safeNowSec(options);
  const pageSize = Math.max(1, Math.min(TELEGRAM_RECAP_DUE_PAGE_SIZE, Math.floor(options.pageSize ?? TELEGRAM_RECAP_DUE_PAGE_SIZE)));
  const maxPages = Math.max(1, Math.min(TELEGRAM_RECAP_MAX_PAGES_PER_RUN, Math.floor(options.maxPages ?? TELEGRAM_RECAP_MAX_PAGES_PER_RUN)));
  const tapePageLimit = Math.max(1, Math.floor(options.tapePageLimit ?? TELEGRAM_RECAP_TAPE_PAGE_LIMIT));
  const softDeadlineMs = Math.max(0, Math.floor(options.softDeadlineMs ?? TELEGRAM_RECAP_PLANNER_SOFT_DEADLINE_MS));
  const rolloutPolicy = options.rolloutPolicy ?? TELEGRAM_RECAP_PUBLIC_ROLLOUT_POLICY;
  const dryRun = !shouldQueueTelegramRecap(rolloutPolicy);
  const eligibleChatIds = rolloutPolicy.mode === "canary"
    ? [...rolloutPolicy.allowedChatIds]
    : undefined;
  const counts = {
    pagesAttempted: 0,
    pagesCompleted: 0,
    pagesDeferred: 0,
    due: 0,
    queued: 0,
    projected: 0,
    projectedMaterial: 0,
    noChanges: 0,
    paused: 0,
    stale: 0,
    deferred: 0,
    presetDeferred: 0,
    truncatedDeferred: 0,
    invalidTimezone: 0,
    softDeadlineDeferred: 0,
    factsLoaded: 0,
    factsAdmitted: 0,
    factsRejected: 0,
    factsOmittedByMessageCap: 0,
    factFamilyOmissions: Object.fromEntries(
      TELEGRAM_RECAP_FACT_FAMILIES.map((family) => [family, 0]),
    ) as Record<string, number>,
    oldestDueAgeSec: 0,
    nextDueAt: null as number | null,
  };
  const finish = (status: "ok" | "degraded", tapeFreshness: "fresh" | "stale"): TelegramRecapPlannerResult => createCronResult({
    status,
    itemCount: counts.queued + counts.noChanges + counts.paused + counts.stale,
    metadata: {
      ...counts,
      tapeFreshness,
      wallDurationMs: Math.max(0, Date.now() - startedAtMs),
      maxRecipientsPerRun: TELEGRAM_RECAP_MAX_RECIPIENTS_PER_RUN,
      rollout: {
        mode: rolloutPolicy.mode,
        pendingEffects: !dryRun,
        eligibleChatCount: eligibleChatIds?.length ?? null,
      },
      aiCalls: 0,
      externalPlanningFetches: 0,
    },
  }) as TelegramRecapPlannerResult;
  const deadlineReached = () => Date.now() - startedAtMs >= softDeadlineMs;

  if (rolloutPolicy.mode === "off") return finish("ok", "fresh");

  throwIfAborted(signal);
  const freshAt = await loadFreshProjectTapeAt(db);
  if (freshAt == null || nowSec - freshAt > TELEGRAM_RECAP_TAPE_FRESHNESS_SEC) {
    const due = await listDueTelegramRecapPreferences(db, nowSec, pageSize, { chatIds: eligibleChatIds });
    const subscribers = await loadSubscriberRows(db, due.map((preference) => preference.chatId));
    counts.due = due.length;
    counts.stale = dryRun
      ? due.filter((preference) => shouldRecordStaleSkip(preference, nowSec)).length
      : await recordStalePage(db, due, subscribers, nowSec, "project-tape-stale");
    counts.oldestDueAgeSec = Math.max(0, ...due.map((preference) => nowSec - preference.expectedNextDueAt));
    return finish("degraded", "stale");
  }

  pageLoop: for (let page = 0; page < maxPages; page += 1) {
    throwIfAborted(signal);
    if (deadlineReached()) {
      counts.deferred += 1;
      counts.softDeadlineDeferred += 1;
      counts.pagesDeferred += 1;
      break;
    }
    const preferences = await listDueTelegramRecapPreferences(db, nowSec, pageSize, {
      chatIds: eligibleChatIds,
      // A dark projection cannot advance next_due_at, so its durable page
      // cursor is an offset rather than the normal schedule re-read.
      offset: dryRun ? page * pageSize : 0,
    });
    if (preferences.length === 0) break;
    counts.pagesAttempted += 1;
    counts.due += preferences.length;
    counts.oldestDueAgeSec = Math.max(
      counts.oldestDueAgeSec,
      ...preferences.map((preference) => Math.max(0, nowSec - preference.expectedNextDueAt)),
    );
    const subscriberByChat = await loadSubscriberRows(db, preferences.map((preference) => preference.chatId));
    const stalePreferences = preferences.filter((preference) =>
      shouldRecordStaleSkip(preference, nowSec) && subscriberByChat.get(preference.chatId)?.timezone,
    );
    const staleChatIds = new Set(stalePreferences.map((preference) => preference.chatId));
    if (stalePreferences.length > 0) {
      const recorded = dryRun
        ? stalePreferences.length
        : await recordStalePage(db, stalePreferences, subscriberByChat, nowSec, "delivery-window-expired");
      counts.stale += recorded;
      counts.deferred += stalePreferences.length - recorded;
    }
    const planningPreferences = preferences.filter((preference) => !staleChatIds.has(preference.chatId));
    if (planningPreferences.length === 0) {
      counts.pagesCompleted += 1;
      continue;
    }
    const chatIds = planningPreferences.map((preference) => preference.chatId);
    const directByChat = await loadDirectSubscriptions(db, chatIds, nowSec);
    const presetsByChat = await loadPresetSubscriptions(db, chatIds);
    const allPresetIds = [...new Set([...presetsByChat.values()].flat())];
    const resolvedPresets = allPresetIds.length === 0
      ? { kind: "ok" as const, presets: [] }
      : await resolveTelegramPresetTargets(db, allPresetIds);
    if (resolvedPresets.kind !== "ok") {
      counts.deferred += planningPreferences.length;
      counts.presetDeferred += planningPreferences.length;
      counts.pagesDeferred += 1;
      break;
    }
    const earliestStartSec = Math.min(...planningPreferences.map((preference) => recapWindow(preference, nowSec).startSec));
    const loadedFacts = await loadTapeFacts(db, earliestStartSec, nowSec, tapePageLimit);
    counts.factsLoaded += loadedFacts.loadedCount;
    counts.factsAdmitted += loadedFacts.facts.length;
    counts.factsRejected += loadedFacts.rejectedCount;
    if (loadedFacts.truncated) {
      counts.deferred += planningPreferences.length;
      counts.truncatedDeferred += planningPreferences.length;
      counts.pagesDeferred += 1;
      break;
    }
    const presetCoinIds = new Map<TelegramPresetId, readonly string[]>(
      resolvedPresets.presets.map((preset) => [preset.definition.id, preset.stablecoinIds]),
    );

    for (const [preferenceIndex, preference] of planningPreferences.entries()) {
      throwIfAborted(signal);
      if (deadlineReached()) {
        const deferred = planningPreferences.length - preferenceIndex;
        counts.deferred += deferred;
        counts.softDeadlineDeferred += deferred;
        counts.pagesDeferred += 1;
        break pageLoop;
      }
      const subscriber = subscriberByChat.get(preference.chatId);
      if (!shouldPlanTelegramRecap(rolloutPolicy, preference.chatId)) continue;
      const timezone = subscriber?.timezone;
      if (!subscriber || !timezone) {
        counts.invalidTimezone += 1;
        counts.deferred += 1;
        continue;
      }
      const localDate = localDateInIanaTimezone(nowSec * 1000, timezone);
      if (!localDate) {
        counts.invalidTimezone += 1;
        counts.deferred += 1;
        continue;
      }
      const nextDueAt = nextDueAtAfterLocalDateSec(
        nowSec,
        timezone,
        preference.deliveryHourLocal,
        localDate,
      );
      if (nextDueAt == null) {
        counts.invalidTimezone += 1;
        counts.deferred += 1;
        continue;
      }
      counts.nextDueAt = counts.nextDueAt == null ? nextDueAt : Math.min(counts.nextDueAt, nextDueAt);
      const window = recapWindow(preference, nowSec);
      const recapKey = buildTelegramRecapDedupeKey(preference.chatId, localDate);
      const scope = scopeForRecipient(subscriber, directByChat, presetsByChat, presetCoinIds);
      const fingerprint = await sha256Hex(scope.fingerprintParts.join("\n"));
      const target = {
        recapKey,
        chatId: preference.chatId,
        localDate,
        windowStartAt: window.startSec,
        windowEndAt: window.endSec,
        tapeHighWaterId: loadedFacts.highWaterId,
        preferenceGeneration: preference.preferenceGeneration,
        watchlistFingerprint: fingerprint,
        nowSec,
        expectedNextDueAt: preference.expectedNextDueAt,
        nextDueAtAfter: nextDueAt,
      };
      if (isPaused(subscriber)) {
        if (dryRun || await recordTelegramRecapSkip(db, { target, status: "skipped_paused", reason: "chat-paused" })) counts.paused += 1;
        continue;
      }
      const facts = loadedFacts.facts.filter((fact) => fact.ts > window.startSec * 1000 && fact.ts <= window.endSec * 1000);
      const formatted = formatTelegramRecap({
        facts: buildScopedFacts(scope, facts),
        windowStartAtMs: window.startSec * 1000,
        windowEndAtMs: window.endSec * 1000,
        timezone,
      });
      if (!formatted) {
        if (dryRun || await recordTelegramRecapSkip(db, { target, status: "skipped_no_changes" })) counts.noChanges += 1;
        continue;
      }
      counts.factsOmittedByMessageCap += formatted.omittedFactCount;
      if (dryRun) {
        counts.projected += 1;
        counts.projectedMaterial += 1;
        continue;
      }
      const queued = await queueTelegramRecapTarget(db, {
        ...target,
        pendingDedupeKey: recapKey,
        messageHtml: formatted.body,
        payloadHash: await sha256Hex(formatted.body),
        materialCoinCount: formatted.materialCoinCount,
        materialFactCount: formatted.materialFactCount,
        omittedFactCount: formatted.omittedFactCount,
        markupPolicyJson: serializePendingMarkupPolicy({ replyMarkup: formatted.replyMarkup }),
      });
      if (queued === "queued") counts.queued += 1;
    }
    counts.pagesCompleted += 1;
    // A full page may contain guarded no-ops, but each successful plan/skip
    // advances its own next_due_at; re-reading the page remains the durable cursor.
  }
  return finish(counts.deferred > 0 ? "degraded" : "ok", "fresh");
}
