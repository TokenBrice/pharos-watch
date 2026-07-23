import { isRecord } from "@shared/lib/type-guards";
import { isTelegramAlertType, type TelegramAlertType } from "@shared/types/status";
import { D1_BATCH_SIZE } from "../lib/constants";
import { D1_MAX_BOUND_PARAMETERS } from "../lib/db";
import { sha256Hex } from "../lib/hash";
import { parseJson } from "../lib/json-parse";
import type { BatchMessage } from "../lib/telegram";
import { TELEGRAM_MESSAGE_CHUNK_LIMIT } from "../lib/telegram-constants";
import {
  parsePendingAlertScope,
  parsePendingAlertProvenance,
  parsePendingMarkupPolicy,
  serializePendingAlertScope,
  serializePendingMarkupPolicy,
  isValidPendingSourceEventId,
} from "../lib/telegram-pending-provenance";
import { expandSubscriberChunks, type RoutedSubscriberAlert } from "./dispatch-telegram-routing";
import { listTelegramAlertItemKeys } from "./telegram-alert-event-lineage";
import { buildDedupeKey } from "./telegram-pending";

const TELEGRAM_TARGET_PLAN_SCHEMA_VERSION = 1;
const TELEGRAM_TARGET_PLAN_MAX_JSON_CHARS = 262_144;
export const TELEGRAM_TARGET_PLAN_MAX_CHUNKS = 64;
export const TELEGRAM_TARGET_PLAN_MAX_ITEMS = 512;
const TELEGRAM_TARGET_PLAN_MAX_CANONICAL_HTML_CHARS = 200_000;

interface PersistedTelegramTargetMessageV1 {
  targetKey: string;
  chunkIndex: number;
  html: string;
  markupPolicyJson: string;
}

export interface PersistedTelegramTargetPlanV1 {
  schemaVersion: 1;
  sourceEventId: string;
  chatId: string;
  alertType: TelegramAlertType;
  alertTypes: TelegramAlertType[];
  preferenceGeneration: number;
  canonicalHtml: string;
  disableNotification: boolean;
  alertScopeJson: string;
  targetExpiresAt: number;
  itemKeys: string[];
  messages: PersistedTelegramTargetMessageV1[];
}

export interface SerializedTelegramTargetPlan {
  planKey: string;
  payload: PersistedTelegramTargetPlanV1;
  payloadJson: string;
  payloadDigest: string;
}

export type ParsedTelegramTargetPlan =
  { kind: "ok"; value: PersistedTelegramTargetPlanV1 } | { kind: "invalid"; reason: string };

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isBoundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum;
}

function normalizedItemKeys(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > TELEGRAM_TARGET_PLAN_MAX_ITEMS) {
    return null;
  }
  const keys = value.filter(
    (item): item is string => isBoundedString(item, 200) && !/[\u0000-\u001f\u007f]/.test(item),
  );
  if (keys.length !== value.length) return null;
  const normalized = [...new Set(keys)].sort();
  return normalized.length === keys.length ? normalized : null;
}

export async function serializeTelegramTargetPlan(
  routed: RoutedSubscriberAlert,
  targetExpiresAt: number,
): Promise<SerializedTelegramTargetPlan> {
  if (
    !routed.sourceEventId ||
    !isValidPendingSourceEventId(routed.sourceEventId) ||
    !Number.isSafeInteger(routed.preferenceGeneration) ||
    (routed.preferenceGeneration ?? -1) < 0 ||
    !routed.alertScope ||
    !Number.isSafeInteger(targetExpiresAt) ||
    targetExpiresAt <= 0
  ) {
    throw new Error("Telegram target plan requires complete immutable provenance");
  }
  if (
    routed.alertScope.some((item) => item.family === "safety") &&
    !routed.safetyScoreIdentity
  ) {
    throw new Error("Telegram safety target plan requires a Safety Score identity");
  }

  const messages = expandSubscriberChunks([routed]);
  if (messages.length === 0 || messages.length > TELEGRAM_TARGET_PLAN_MAX_CHUNKS) {
    throw new Error(`Telegram target plan chunk count is outside 1-${TELEGRAM_TARGET_PLAN_MAX_CHUNKS}`);
  }
  if (
    routed.canonicalHtml.length === 0 ||
    routed.canonicalHtml.length > TELEGRAM_TARGET_PLAN_MAX_CANONICAL_HTML_CHARS
  ) {
    throw new Error("Telegram target plan canonical HTML exceeds the persisted limit");
  }

  const itemKeys = listTelegramAlertItemKeys(routed.alerts);
  if (itemKeys.length === 0 || itemKeys.length > TELEGRAM_TARGET_PLAN_MAX_ITEMS) {
    throw new Error(`Telegram target plan item count is outside 1-${TELEGRAM_TARGET_PLAN_MAX_ITEMS}`);
  }
  const alertScopeJson = serializePendingAlertScope(
    routed.alertScope,
    routed.safetyScoreIdentity,
  );
  const payload: PersistedTelegramTargetPlanV1 = {
    schemaVersion: TELEGRAM_TARGET_PLAN_SCHEMA_VERSION,
    sourceEventId: routed.sourceEventId,
    chatId: routed.chatId,
    alertType: routed.alertType,
    alertTypes: [...(routed.alertTypes ?? [routed.alertType])],
    preferenceGeneration: routed.preferenceGeneration!,
    canonicalHtml: routed.canonicalHtml,
    disableNotification: routed.disableNotification,
    alertScopeJson,
    targetExpiresAt,
    itemKeys,
    messages: messages.map((message, chunkIndex) => ({
      targetKey: buildDedupeKey(message),
      chunkIndex,
      html: message.html,
      markupPolicyJson: serializePendingMarkupPolicy({
        replyMarkup: message.replyMarkup,
        linkPreviewOptions: message.linkPreviewOptions,
      }),
    })),
  };
  const payloadJson = JSON.stringify(payload);
  if (payloadJson.length > TELEGRAM_TARGET_PLAN_MAX_JSON_CHARS) {
    throw new Error("Telegram target plan payload exceeds the persisted JSON limit");
  }
  const payloadDigest = await sha256Hex(payloadJson);
  return {
    planKey: `${routed.chatId}:${routed.alertType}:${payloadDigest.slice(0, 32)}`,
    payload,
    payloadJson,
    payloadDigest,
  };
}

export async function parseTelegramTargetPlan(
  payloadJson: string,
  expectedDigest?: string,
): Promise<ParsedTelegramTargetPlan> {
  if (payloadJson.length < 2 || payloadJson.length > TELEGRAM_TARGET_PLAN_MAX_JSON_CHARS) {
    return { kind: "invalid", reason: "target_plan_size_invalid" };
  }
  if (expectedDigest != null) {
    if (!/^[0-9a-f]{64}$/.test(expectedDigest)) {
      return { kind: "invalid", reason: "target_plan_digest_invalid" };
    }
    if ((await sha256Hex(payloadJson)) !== expectedDigest) {
      return { kind: "invalid", reason: "target_plan_digest_mismatch" };
    }
  }

  const parsed = parseJson(payloadJson);
  if (!parsed.ok) return { kind: "invalid", reason: "target_plan_json_invalid" };
  const value = parsed.value;
  if (
    !isRecord(value) ||
    value.schemaVersion !== TELEGRAM_TARGET_PLAN_SCHEMA_VERSION ||
    !isBoundedString(value.sourceEventId, 200) ||
    !isValidPendingSourceEventId(value.sourceEventId) ||
    !isBoundedString(value.chatId, 200) ||
    !isTelegramAlertType(value.alertType) ||
    !isSafeNonNegativeInteger(value.preferenceGeneration) ||
    !isBoundedString(value.canonicalHtml, TELEGRAM_TARGET_PLAN_MAX_CANONICAL_HTML_CHARS) ||
    typeof value.disableNotification !== "boolean" ||
    typeof value.alertScopeJson !== "string" ||
    !Number.isSafeInteger(value.targetExpiresAt) ||
    Number(value.targetExpiresAt) <= 0
  ) {
    return { kind: "invalid", reason: "target_plan_shape_invalid" };
  }
  const alertTypes = value.alertTypes == null ? [value.alertType] : value.alertTypes;
  if (!Array.isArray(alertTypes) || alertTypes.length === 0 || alertTypes.some((type) => !isTelegramAlertType(type))) {
    return { kind: "invalid", reason: "target_plan_alert_types_invalid" };
  }
  const normalizedAlertTypes = [...new Set(alertTypes as TelegramAlertType[])];
  if (normalizedAlertTypes.length !== alertTypes.length || !normalizedAlertTypes.includes(value.alertType)) {
    return { kind: "invalid", reason: "target_plan_alert_types_invalid" };
  }
  const alertScope = parsePendingAlertScope(value.alertScopeJson);
  const provenance = parsePendingAlertProvenance(value.alertScopeJson);
  if (
    alertScope.kind !== "ok" ||
    provenance.kind !== "ok" ||
    alertScope.value.length > TELEGRAM_TARGET_PLAN_MAX_ITEMS
  ) {
    return { kind: "invalid", reason: "target_plan_scope_invalid" };
  }
  const itemKeys = normalizedItemKeys(value.itemKeys);
  if (!itemKeys) return { kind: "invalid", reason: "target_plan_items_invalid" };
  if (
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > TELEGRAM_TARGET_PLAN_MAX_CHUNKS
  ) {
    return { kind: "invalid", reason: "target_plan_messages_invalid" };
  }

  const messages: PersistedTelegramTargetMessageV1[] = [];
  const targetKeys = new Set<string>();
  for (const [index, message] of value.messages.entries()) {
    if (
      !isRecord(message) ||
      !isBoundedString(message.targetKey, 200) ||
      message.chunkIndex !== index ||
      !isBoundedString(message.html, TELEGRAM_MESSAGE_CHUNK_LIMIT) ||
      typeof message.markupPolicyJson !== "string"
    ) {
      return { kind: "invalid", reason: "target_plan_message_shape_invalid" };
    }
    const markup = parsePendingMarkupPolicy(message.markupPolicyJson);
    if (markup.kind !== "ok") {
      return { kind: "invalid", reason: "target_plan_markup_invalid" };
    }
    const reconstructed: BatchMessage = {
      chatId: value.chatId,
      html: message.html,
      canonicalHtml: value.canonicalHtml,
      disableNotification: value.disableNotification,
      chunkIndex: index,
    };
    if (buildDedupeKey(reconstructed) !== message.targetKey || targetKeys.has(message.targetKey)) {
      return { kind: "invalid", reason: "target_plan_target_key_invalid" };
    }
    targetKeys.add(message.targetKey);
    messages.push({
      targetKey: message.targetKey,
      chunkIndex: index,
      html: message.html,
      markupPolicyJson: message.markupPolicyJson,
    });
  }

  return {
    kind: "ok",
    value: {
      schemaVersion: TELEGRAM_TARGET_PLAN_SCHEMA_VERSION,
      sourceEventId: value.sourceEventId,
      chatId: value.chatId,
      alertType: value.alertType,
      alertTypes: normalizedAlertTypes,
      preferenceGeneration: value.preferenceGeneration,
      canonicalHtml: value.canonicalHtml,
      disableNotification: value.disableNotification,
      alertScopeJson: value.alertScopeJson,
      targetExpiresAt: Number(value.targetExpiresAt),
      itemKeys,
      messages,
    },
  };
}

export interface TelegramPlanMaterializationBatchInvariant {
  targetInsertStatements: number;
  itemInsertStatements: number;
  markerStatements: number;
  totalStatements: number;
  batchLimit: number;
}

export function telegramPlanMaterializationBatchInvariant(): TelegramPlanMaterializationBatchInvariant {
  const targetColumns = 20;
  const itemColumns = 5;
  const targetRowsPerStatement = Math.floor(D1_MAX_BOUND_PARAMETERS / targetColumns);
  const itemRowsPerStatement = Math.floor(D1_MAX_BOUND_PARAMETERS / itemColumns);
  const targetInsertStatements = Math.ceil(TELEGRAM_TARGET_PLAN_MAX_CHUNKS / targetRowsPerStatement);
  const itemInsertStatements = Math.ceil(TELEGRAM_TARGET_PLAN_MAX_ITEMS / itemRowsPerStatement);
  const markerStatements = 3;
  return {
    targetInsertStatements,
    itemInsertStatements,
    markerStatements,
    totalStatements: targetInsertStatements + itemInsertStatements + markerStatements,
    batchLimit: D1_BATCH_SIZE,
  };
}

export function assertTelegramPlanMaterializationFitsD1Batch(): void {
  const invariant = telegramPlanMaterializationBatchInvariant();
  if (invariant.totalStatements > invariant.batchLimit) {
    throw new Error(
      `Telegram target plan materialization exceeds the D1 batch limit (${invariant.totalStatements}/${invariant.batchLimit})`,
    );
  }
}
