import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { setSubscriptionSnooze, unixNow } from "../telegram-webhook-store";
import {
  hasExactParts,
  isSubscribableStablecoinId,
  isSnoozeArg,
  runCallbackMutation,
  SNOOZE_SECONDS,
  type CallbackHandler,
  type SnoozeArg,
} from "./_shared";

export const handleCoinSnoozeCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  await runCallbackMutation<{ id: string; duration: SnoozeArg }>({
    db,
    botToken,
    cb,
    chatId,
    validate: () => {
      const durationToken = parsed.parts[2];
      if (
        !hasExactParts(parsed.parts, 3) ||
        !isSubscribableStablecoinId(parsed.arg) ||
        !isSnoozeArg(durationToken)
      ) {
        return null;
      }
      return { id: parsed.arg, duration: durationToken };
    },
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "coin",
    logAction: "coinsnooze",
    logMessage: "coinsnooze write failed",
    successOutcome: "set",
    write: async ({ id, duration }) =>
      setSubscriptionSnooze(db, chatId, id, unixNow() + SNOOZE_SECONDS[duration]),
    successText: ({ id, duration }) =>
      `Snoozed ${TRACKED_META_BY_ID.get(id)?.symbol ?? id} for ${duration}.`,
    failureText: "Could not save snooze. Please try again.",
  });
};
