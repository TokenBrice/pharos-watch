import { WORKER_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import { setSubscriptionSnooze } from "../store/snooze";
import { unixNow } from "../store/subscribers";
import { cmdForChat } from "../webhook/telegram-webhook-messages";
import {
  callbackChatType,
  hasExactParts,
  isSubscribableStablecoinId,
  isSnoozeArg,
  runCallbackMutation,
  SNOOZE_SECONDS,
  type CallbackHandler,
  type SnoozeArg,
} from "./_shared";

export const handleCoinSnoozeCallback: CallbackHandler = async (context) => {
  const { db, cb, chatId, parsed } = context;
  const chatType = callbackChatType(cb);
  const undo = chatType === "private"
    ? "Undo in Manage Alerts."
    : `Undo with ${cmdForChat("settings", chatType)}.`;
  await runCallbackMutation<{ id: string; duration: SnoozeArg; untilSec: number }>(context, {
    validate: () => {
      const durationToken = parsed.parts[2];
      if (
        !hasExactParts(parsed.parts, 3) ||
        !isSubscribableStablecoinId(parsed.arg) ||
        !isSnoozeArg(durationToken)
      ) {
        return null;
      }
      const untilSec = unixNow() + SNOOZE_SECONDS[durationToken];
      return Number.isFinite(untilSec)
        ? { id: parsed.arg, duration: durationToken, untilSec }
        : null;
    },
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "coin",
    logAction: "coinsnooze",
    logMessage: "coinsnooze write failed",
    successOutcome: "set",
    write: async ({ id, untilSec }, options) =>
      setSubscriptionSnooze(db, chatId, id, untilSec, options),
    successText: ({ id, duration }) =>
      `${TRACKED_META_BY_ID.get(id)?.symbol ?? id} snoozed for ${duration}. ${undo}`,
    failureText: "Could not save snooze. Please try again.",
  });
};
