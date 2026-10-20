import type { TelegramAlertType } from "@shared/types/status";
import { TELEGRAM_ALERT_PERSISTENCE } from "@shared/lib/telegram-alert-families";
import { FREEZE_CLAIM_RETRACTED_REASON } from "@shared/types/tape-event-constants";
import { loadRetractedFreezeAlertIds } from "../freeze/telegram-alert-freeze";
import type { SafetyScorePublicationIdentity } from "@shared/types/safety-score-publication";
import { buildInClause, chunkArray } from "../../../lib/db";
import {
  isValidPendingSourceEventId,
  parsePendingAlertProvenance,
  parsePendingMarkupPolicy,
  type PendingAlertScopeItem,
  type PendingMarkupPolicyV1,
} from "../../../telegram/outbox/pending-provenance";
import {
  alertSafetyIdentitiesAreComparable,
  loadActiveAlertSafetySourceAssessment,
} from "../../../lib/alert-safety-source-cache";
import {
  listTelegramPresets,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
  type TelegramPresetResolveOptions,
} from "../../../telegram/common/presets";
import type { PendingAlertRow } from "./types";

const INVALID_PROVENANCE_RETRY_SEC = 15 * 60;
const PRESET_UNAVAILABLE_RETRY_SEC = 5 * 60;
const SAFETY_UNAVAILABLE_RETRY_SEC = 5 * 60;
const SUBSCRIPTION_PAIR_CHUNK_SIZE = 40;
const VALID_PRESET_IDS = new Set(listTelegramPresets().map((preset) => preset.id));

const GLOBAL_COLUMNS_SQL = Object.values(TELEGRAM_ALERT_PERSISTENCE)
  .map((spec) => spec.globalColumn).join(", ");
const SUBSCRIPTION_COLUMNS_SQL = Object.values(TELEGRAM_ALERT_PERSISTENCE)
  .flatMap((spec) => [spec.subscriptionColumn, spec.overrideColumn]).join(", ");
const PRESET_COLUMNS_SQL = (["dews", "depeg", "safety"] as const)
  .map((family) => TELEGRAM_ALERT_PERSISTENCE[family].subscriptionColumn).join(", ");

interface PreferenceSubscriberRow {
  chat_id: string;
  preference_generation: number;
  alert_snooze_until_ts: number | null;
  global_alert_dews: number;
  global_alert_depeg: number;
  global_alert_safety: number;
  global_alert_launch: number;
  global_alert_reserve: number;
  global_alert_freeze: number;
}

interface PreferenceSubscriptionRow {
  chat_id: string;
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  alert_launch: number;
  alert_reserve: number;
  alert_freeze: number;
  alert_dews_override: number;
  alert_depeg_override: number;
  alert_safety_override: number;
  alert_launch_override: number;
  alert_reserve_override: number;
  alert_freeze_override: number;
  alert_snooze_until_ts: number | null;
}

interface PreferencePresetRow {
  chat_id: string;
  preset_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
}

interface ParsedPendingIntent {
  kind: "risk-alert";
  row: PendingAlertRow;
  scope: PendingAlertScopeItem[];
  safetyScoreIdentity: SafetyScorePublicationIdentity | null;
  markupPolicy: PendingMarkupPolicyV1;
}


export type PendingPreferenceRevalidation =
  | {
      kind: "eligible";
      row: PendingAlertRow;
      validatedPreferenceGeneration: number | null;
      markupPolicy: PendingMarkupPolicyV1 | null;
    }
  | { kind: "defer"; row: PendingAlertRow; notBeforeAt: number; reason: string }
  | { kind: "cancel"; row: PendingAlertRow; reason: string };

function pairKey(chatId: string, stablecoinId: string): string {
  return `${chatId}\0${stablecoinId}`;
}

function parseIntent(
  row: PendingAlertRow,
  nowSec: number,
): PendingPreferenceRevalidation | ParsedPendingIntent {
  if (row.source_type === "admin_replay") {
    const markup = parsePendingMarkupPolicy(row.markup_policy_json);
    if (markup.kind !== "ok") {
      return {
        kind: "defer",
        row,
        notBeforeAt: nowSec + INVALID_PROVENANCE_RETRY_SEC,
        reason: markup.kind === "invalid" ? markup.reason : "admin_replay_markup_policy_missing",
      };
    }
    return {
      kind: "eligible",
      row,
      validatedPreferenceGeneration: null,
      markupPolicy: markup.value,
    };
  }
  if (row.source_type !== "risk_alert") {
    if (row.source_type != null && row.source_type !== "legacy" && row.source_type !== "admin_broadcast") {
      return { kind: "cancel", row, reason: "unsupported_source_type" };
    }
    return {
      kind: "eligible",
      row,
      validatedPreferenceGeneration: null,
      markupPolicy: null,
    };
  }
  const provenance = [
    row.source_event_id,
    row.alert_scope_json,
    row.preference_generation,
    row.markup_policy_json,
  ];
  if (provenance.every((value) => value == null)) {
    if (row.alert_type === "safety") {
      return { kind: "cancel", row, reason: "safety_identity_missing" };
    }
    return {
      kind: "eligible",
      row,
      validatedPreferenceGeneration: null,
      markupPolicy: null,
    };
  }
  if (provenance.some((value) => value == null)) {
    return {
      kind: "defer",
      row,
      notBeforeAt: nowSec + INVALID_PROVENANCE_RETRY_SEC,
      reason: "preference_provenance_incomplete",
    };
  }
  if (
    typeof row.source_event_id !== "string" ||
    !isValidPendingSourceEventId(row.source_event_id) ||
    !Number.isSafeInteger(row.preference_generation) ||
    (row.preference_generation ?? -1) < 0
  ) {
    return {
      kind: "defer",
      row,
      notBeforeAt: nowSec + INVALID_PROVENANCE_RETRY_SEC,
      reason: "preference_provenance_invalid",
    };
  }
  const scope = parsePendingAlertProvenance(row.alert_scope_json);
  if (scope.kind !== "ok") {
    return {
      kind: "defer",
      row,
      notBeforeAt: nowSec + INVALID_PROVENANCE_RETRY_SEC,
      reason: scope.kind === "invalid" ? scope.reason : "preference_provenance_incomplete",
    };
  }
  const markup = parsePendingMarkupPolicy(row.markup_policy_json);
  if (markup.kind !== "ok") {
    return {
      kind: "defer",
      row,
      notBeforeAt: nowSec + INVALID_PROVENANCE_RETRY_SEC,
      reason: markup.kind === "invalid" ? markup.reason : "preference_provenance_incomplete",
    };
  }
  return {
    kind: "risk-alert",
    row,
    scope: scope.value.scope,
    safetyScoreIdentity: scope.value.safetyScoreIdentity,
    markupPolicy: markup.value,
  };
}



async function loadPreferenceSubscribers(
  db: D1Database,
  chatIds: readonly string[],
): Promise<Map<string, PreferenceSubscriberRow>> {
  const subscribers = new Map<string, PreferenceSubscriberRow>();
  for (const chatChunk of chunkArray(Array.from(new Set(chatIds)))) {
    const inClause = buildInClause(chatChunk);
    const rows = await db
      .prepare(
        // SAFETY: column projections derive only from TELEGRAM_ALERT_PERSISTENCE.
        `SELECT chat_id, preference_generation, alert_snooze_until_ts,
                ${GLOBAL_COLUMNS_SQL}
           FROM telegram_subscribers
          WHERE chat_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<PreferenceSubscriberRow>();
    for (const row of rows.results ?? []) subscribers.set(row.chat_id, row);
  }
  return subscribers;
}

async function loadPreferenceSubscriptions(
  db: D1Database,
  intents: readonly ParsedPendingIntent[],
): Promise<Map<string, PreferenceSubscriptionRow>> {
  const uniquePairs = new Map<string, { chatId: string; stablecoinId: string }>();
  for (const intent of intents) {
    for (const item of intent.scope) {
      uniquePairs.set(pairKey(intent.row.chat_id, item.stablecoinId), {
        chatId: intent.row.chat_id,
        stablecoinId: item.stablecoinId,
      });
    }
  }
  const subscriptions = new Map<string, PreferenceSubscriptionRow>();
  for (const pairChunk of chunkArray([...uniquePairs.values()], SUBSCRIPTION_PAIR_CHUNK_SIZE)) {
    const predicate = pairChunk.map(() => "(chat_id = ? AND stablecoin_id = ?)").join(" OR ");
    const binds = pairChunk.flatMap((pair) => [pair.chatId, pair.stablecoinId]);
    const rows = await db
      .prepare(
        // SAFETY: column projections derive only from TELEGRAM_ALERT_PERSISTENCE.
        `SELECT chat_id, stablecoin_id, ${SUBSCRIPTION_COLUMNS_SQL}, alert_snooze_until_ts
           FROM telegram_subscriptions
          WHERE ${predicate}`,
      )
      .bind(...binds)
      .all<PreferenceSubscriptionRow>();
    for (const row of rows.results ?? []) {
      subscriptions.set(pairKey(row.chat_id, row.stablecoin_id), row);
    }
  }
  return subscriptions;
}

function directEligibility(
  subscriber: PreferenceSubscriberRow,
  subscription: PreferenceSubscriptionRow | undefined,
  family: TelegramAlertType,
): "eligible" | "disabled" | "preset-needed" {
  const columns = TELEGRAM_ALERT_PERSISTENCE[family];
  if (subscription?.[columns.subscriptionColumn] === 1) return "eligible";
  if (subscription?.[columns.overrideColumn] === 1) return "disabled";
  if (subscriber[columns.globalColumn] === 1) return "eligible";
  return "preset-needed";
}

async function loadPreferencePresets(
  db: D1Database,
  chatIds: readonly string[],
): Promise<Map<string, PreferencePresetRow[]>> {
  const presets = new Map<string, PreferencePresetRow[]>();
  for (const chatChunk of chunkArray(Array.from(new Set(chatIds)))) {
    const inClause = buildInClause(chatChunk);
    const rows = await db
      .prepare(
        // SAFETY: column projections derive only from TELEGRAM_ALERT_PERSISTENCE.
        `SELECT chat_id, preset_id, ${PRESET_COLUMNS_SQL}
           FROM telegram_preset_subscriptions
          WHERE chat_id IN (${inClause.sql})`,
      )
      .bind(...inClause.binds)
      .all<PreferencePresetRow>();
    for (const row of rows.results ?? []) {
      const current = presets.get(row.chat_id) ?? [];
      current.push(row);
      presets.set(row.chat_id, current);
    }
  }
  return presets;
}

function enabledPresetIdsForFamily(
  rows: readonly PreferencePresetRow[],
  family: TelegramAlertType,
): TelegramPresetId[] {
  if (family === "launch" || family === "reserve" || family === "freeze") return [];
  const column = TELEGRAM_ALERT_PERSISTENCE[family].subscriptionColumn;
  return rows.flatMap((row) =>
    row[column] === 1 && VALID_PRESET_IDS.has(row.preset_id as TelegramPresetId)
      ? [row.preset_id as TelegramPresetId]
      : []);
}

export async function revalidatePendingAlertPreferences(
  db: D1Database,
  rows: readonly PendingAlertRow[],
  nowSec: number,
  presetOptions: TelegramPresetResolveOptions = {},
): Promise<PendingPreferenceRevalidation[]> {
  const outcomes = new Map<number, PendingPreferenceRevalidation>();
  let intents: ParsedPendingIntent[] = [];
  const retracted = await loadRetractedFreezeAlertIds(db, rows
    .filter((row) => row.alert_type === "freeze" && row.delivery_state === "pending")
    .flatMap((row) => row.source_event_id == null ? [] : [row.source_event_id]));
  for (const row of rows) {
    if (row.source_event_id != null && retracted.has(row.source_event_id)) {
      outcomes.set(row.id, { kind: "cancel", row, reason: FREEZE_CLAIM_RETRACTED_REASON });
      continue;
    }
    const parsed = parseIntent(row, nowSec);
    if ("scope" in parsed) intents.push(parsed);
    else outcomes.set(row.id, parsed);
  }
  const safetyIntents = intents.filter((intent) =>
    intent.scope.some((item) => item.family === "safety"));
  if (safetyIntents.length > 0) {
    const safetyAssessment = await loadActiveAlertSafetySourceAssessment(db, nowSec);
    const currentSafetyIdentity = safetyAssessment.envelope?.safetyScoreIdentity;
    const retained: ParsedPendingIntent[] = [];
    for (const intent of intents) {
      if (!intent.scope.some((item) => item.family === "safety")) {
        retained.push(intent);
        continue;
      }
      if (intent.safetyScoreIdentity == null) {
        outcomes.set(intent.row.id, { kind: "cancel", row: intent.row, reason: "safety_identity_missing" });
      } else if (
        currentSafetyIdentity != null &&
        !alertSafetyIdentitiesAreComparable(intent.safetyScoreIdentity, currentSafetyIdentity)
      ) {
        outcomes.set(intent.row.id, { kind: "cancel", row: intent.row, reason: "safety_identity_changed" });
      } else if (safetyAssessment.state !== "ok" || currentSafetyIdentity == null) {
        outcomes.set(intent.row.id, {
          kind: "defer",
          row: intent.row,
          notBeforeAt: nowSec + SAFETY_UNAVAILABLE_RETRY_SEC,
          reason: safetyAssessment.failureReason ?? "safety_identity_unavailable",
        });
      } else {
        retained.push(intent);
      }
    }
    intents = retained;
  }
  if (intents.length === 0) return rows.flatMap((row) => outcomes.get(row.id) ?? []);

  const subscribers = await loadPreferenceSubscribers(db, intents.map((intent) => intent.row.chat_id));
  const subscriptions = await loadPreferenceSubscriptions(db, intents);
  const chatsNeedingPresets = new Set<string>();
  for (const intent of intents) {
    const subscriber = subscribers.get(intent.row.chat_id);
    if (!subscriber) continue;
    if (intent.scope.some((item) =>
      directEligibility(
        subscriber,
        subscriptions.get(pairKey(intent.row.chat_id, item.stablecoinId)),
        item.family,
      ) === "preset-needed")) {
      chatsNeedingPresets.add(intent.row.chat_id);
    }
  }
  const presetsByChat = await loadPreferencePresets(db, [...chatsNeedingPresets]);
  const requiredPresetIds = new Set<TelegramPresetId>();
  for (const intent of intents) {
    const subscriber = subscribers.get(intent.row.chat_id);
    if (!subscriber) continue;
    for (const item of intent.scope) {
      const subscription = subscriptions.get(pairKey(intent.row.chat_id, item.stablecoinId));
      if (directEligibility(subscriber, subscription, item.family) !== "preset-needed") continue;
      for (const presetId of enabledPresetIdsForFamily(presetsByChat.get(intent.row.chat_id) ?? [], item.family)) {
        requiredPresetIds.add(presetId);
      }
    }
  }
  const presetResolution = requiredPresetIds.size > 0
    ? await resolveTelegramPresetTargets(db, [...requiredPresetIds], presetOptions)
    : { kind: "ok" as const, presets: [] };
  const presetMembership = presetResolution.kind === "ok"
    ? new Map(presetResolution.presets.map((preset) => [preset.definition.id, new Set(preset.stablecoinIds)] as const))
    : null;

  for (const intent of intents) {
    const subscriber = subscribers.get(intent.row.chat_id);
    if (!subscriber) {
      outcomes.set(intent.row.id, { kind: "cancel", row: intent.row, reason: "subscriber_missing" });
      continue;
    }
    let cancellationReason: string | null = null;
    let presetUnavailable = false;
    let snoozeUntil = subscriber.alert_snooze_until_ts != null && subscriber.alert_snooze_until_ts > nowSec
      ? subscriber.alert_snooze_until_ts
      : 0;
    for (const item of intent.scope) {
      const subscription = subscriptions.get(pairKey(intent.row.chat_id, item.stablecoinId));
      if (subscription?.alert_snooze_until_ts != null && subscription.alert_snooze_until_ts > nowSec) {
        snoozeUntil = Math.max(snoozeUntil, subscription.alert_snooze_until_ts);
      }
      const direct = directEligibility(subscriber, subscription, item.family);
      if (direct === "disabled") {
        cancellationReason = "scope_disabled";
        break;
      }
      if (direct === "eligible") continue;
      const candidatePresetIds = enabledPresetIdsForFamily(
        presetsByChat.get(intent.row.chat_id) ?? [],
        item.family,
      );
      if (candidatePresetIds.length === 0) {
        cancellationReason = "scope_disabled";
        break;
      }
      if (!presetMembership) {
        presetUnavailable = true;
        continue;
      }
      if (!candidatePresetIds.some((presetId) => presetMembership.get(presetId)?.has(item.stablecoinId))) {
        cancellationReason = "scope_disabled";
        break;
      }
    }
    if (cancellationReason) {
      outcomes.set(intent.row.id, {
        kind: "cancel",
        row: intent.row,
        reason: cancellationReason,
      });
    } else if (presetUnavailable) {
      outcomes.set(intent.row.id, {
        kind: "defer",
        row: intent.row,
        notBeforeAt: nowSec + PRESET_UNAVAILABLE_RETRY_SEC,
        reason: "preference_preset_unavailable",
      });
    } else if (snoozeUntil > nowSec) {
      outcomes.set(intent.row.id, {
        kind: "defer",
        row: intent.row,
        notBeforeAt: snoozeUntil,
        reason: "preference_snoozed",
      });
    } else {
      outcomes.set(intent.row.id, {
        kind: "eligible",
        row: intent.row,
        validatedPreferenceGeneration: subscriber.preference_generation,
        markupPolicy: intent.markupPolicy,
      });
    }
  }

  return rows.flatMap((row) => outcomes.get(row.id) ?? []);
}
