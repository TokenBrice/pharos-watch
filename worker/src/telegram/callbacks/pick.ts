import { TELEGRAM_ALERT_TYPES } from "@shared/types/status/telegram";
import { resolveTicker, type ResolvedCoin } from "../common/alerts-parser";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import { applySubscribeIntent, applyUnsubscribeIntent } from "../store/presets";
import { loadSubscriptionsByIds } from "../store/subscriptions";
import {
  buildCoinStatusKeyboard,
  buildStatusMessage,
  buildSubscriptionSummaryMessage,
  buildUnsubscribeSuccessMessage,
  fitsCallbackData,
} from "../webhook/telegram-webhook-messages";
import { loadStatusForCoin } from "../webhook/telegram-webhook-status";
import { sendAuditedTelegramReply } from "../webhook/telegram-webhook-replies";
import {
  callbackChatType,
  callbackUsername,
  requireAdminForMutatingCallback,
  type CallbackHandler,
} from "./_shared";

/**
 * Stateless ticker disambiguation. The button carries the action, the typed
 * ticker and a short hash of the chosen coin id (coin ids can exceed the
 * 64-byte limit); the tap re-resolves the ticker and picks the candidate whose
 * id hashes to the same value, so a registry change cannot select another coin.
 *
 *   pick:st:<ticker>:<hash>                  show one coin's status
 *   pick:un:<ticker>:<hash>                  unfollow one coin
 *   pick:su:<types>[-<step>]:<ticker>:<hash> follow one coin
 */
export type PickAction =
  | { kind: "status" }
  | { kind: "unsubscribe" }
  | { kind: "subscribe"; alertTypes: ReadonlySet<string>; depegStep: DepegStepChoice };

/**
 * `undefined` leaves the stored depeg tuning untouched; `null` is an explicit
 * `depeg-step off` (follow depeg without a step); a number sets the step.
 */
export type DepegStepChoice = 100 | 250 | 500 | null | undefined;

const MAX_PICK_CANDIDATES = 8;
const PICK_TICKER_PATTERN = /^[A-Za-z0-9.$_-]{1,32}$/;
const DEPEG_STEPS = new Set([100, 250, 500]);

/** Alert types as a base-36 bit mask over `TELEGRAM_ALERT_TYPES`. */
export function encodeAlertTypes(alertTypes: ReadonlySet<string>): string {
  return TELEGRAM_ALERT_TYPES.reduce((mask, type, bit) => (alertTypes.has(type) ? mask | (1 << bit) : mask), 0).toString(36);
}

export function decodeAlertTypes(code: string | undefined): Set<string> | null {
  if (!code || !/^[0-9a-z]{1,2}$/.test(code)) return null;
  const mask = parseInt(code, 36);
  if (mask <= 0 || mask >= 1 << TELEGRAM_ALERT_TYPES.length) return null;
  return new Set(TELEGRAM_ALERT_TYPES.filter((_, bit) => (mask & (1 << bit)) !== 0));
}

/** Omitted tuning has no suffix; an explicit `off` is `-0`; a step is `-<bps>`. */
export function encodeSubscribeTypes(alertTypes: ReadonlySet<string>, depegStep: DepegStepChoice): string {
  return `${encodeAlertTypes(alertTypes)}${depegStep === undefined ? "" : `-${depegStep ?? 0}`}`;
}

export function decodeSubscribeTypes(
  code: string | undefined,
): { alertTypes: Set<string>; depegStep: DepegStepChoice } | null {
  const [typesCode, stepCode, extra] = (code ?? "").split("-");
  const alertTypes = decodeAlertTypes(typesCode);
  if (!alertTypes || extra !== undefined) return null;
  if (stepCode === undefined) return { alertTypes, depegStep: undefined };
  if (stepCode === "0") return { alertTypes, depegStep: null };
  const step = Number(stepCode);
  return DEPEG_STEPS.has(step) ? { alertTypes, depegStep: step as 100 | 250 | 500 } : null;
}

function pickPrefix(action: PickAction): string {
  if (action.kind === "status") return "pick:st";
  if (action.kind === "unsubscribe") return "pick:un";
  return `pick:su:${encodeSubscribeTypes(action.alertTypes, action.depegStep)}`;
}

/** 32-bit FNV-1a of the coin id as 8 hex chars. */
export function coinIdHash(id: string): string {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(id)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** One button per candidate, or `null` when the ticker cannot ride in callback data. */
export function buildPickKeyboard(
  action: PickAction,
  ticker: string,
  candidates: readonly ResolvedCoin[],
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } | null {
  if (!PICK_TICKER_PATTERN.test(ticker) || candidates.length > MAX_PICK_CANDIDATES) return null;
  const rows = candidates.map((coin) => [{
    text: `${coin.symbol} · ${coin.name}`,
    callback_data: `${pickPrefix(action)}:${ticker}:${coinIdHash(coin.id)}`,
  }]);
  return rows.every(([button]) => fitsCallbackData(button!.callback_data)) ? { inline_keyboard: rows } : null;
}

function resolvePickedCoin(ticker: string | undefined, hash: string | undefined, scope: "tracked" | "subscribable"): ResolvedCoin | null {
  if (!ticker || !PICK_TICKER_PATTERN.test(ticker) || !hash || !/^[0-9a-f]{8}$/.test(hash)) return null;
  const resolution = resolveTicker(ticker, scope);
  if (resolution.status === "not_found") return null;
  const matches = resolution.matches.filter((coin) => coinIdHash(coin.id) === hash);
  return matches.length === 1 ? matches[0]! : null;
}

export const handlePickCallback: CallbackHandler = async (ctx) => {
  const { db, botToken, cb, chatId, parsed, answerCallback } = ctx;
  const [, op, ...rest] = parsed.parts;
  const subscribe = op === "su" ? decodeSubscribeTypes(rest.shift()) : null;
  const coin = (op === "st" || op === "un" || subscribe) && rest.length === 2
    ? resolvePickedCoin(rest[0], rest[1], op === "su" ? "subscribable" : "tracked")
    : null;
  if (!coin) {
    await answerCallback({ text: "This button is out of date. Send the command again." });
    return;
  }
  const isPrivate = callbackChatType(cb) === "private";

  if (op === "st") {
    const status = await loadStatusForCoin(db, coin.id);
    const replyMarkup = buildCoinStatusKeyboard(coin.id, coin.symbol, { includeMiniAppButton: isPrivate });
    await sendAuditedTelegramReply(db, chatId, buildStatusMessage(coin.symbol, status), botToken, {
      ...(replyMarkup ? { replyMarkup } : {}),
      actionDetail: "callback_pick",
    });
    await answerCallback({ text: coin.symbol });
    return;
  }

  if (!(await requireAdminForMutatingCallback(db, botToken, cb, chatId))) return;
  if (subscribe) {
    await applySubscribeIntent(db, {
      chatId,
      username: callbackUsername(cb),
      alertTypes: subscribe.alertTypes,
      directStablecoinIds: [coin.id],
      depegWorseningBpsStep: subscribe.depegStep,
    });
  } else {
    await applyUnsubscribeIntent(db, { chatId, directStablecoinIds: [coin.id] });
  }
  await recordTelegramUsageEvent(db, {
    eventType: subscribe ? "subscribe" : "unsubscribe",
    actionDetail: "coin",
    outcome: "success",
  });
  const message = subscribe
    ? buildSubscriptionSummaryMessage("Updated subscriptions.", await loadSubscriptionsByIds(db, chatId, [coin.id]))
    : buildUnsubscribeSuccessMessage([coin]);
  await sendAuditedTelegramReply(db, chatId, message, botToken, { actionDetail: "callback_pick" });
  await answerCallback({ text: subscribe ? "Followed." : "Removed." });
};
