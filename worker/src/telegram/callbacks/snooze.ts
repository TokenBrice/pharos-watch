import { setSubscriberSnooze } from "../store/snooze";
import { unixNow } from "../store/subscribers";
import {
  callbackUsername,
  hasExactParts,
  isSnoozeArg,
  runCallbackMutation,
  SNOOZE_SECONDS,
  type CallbackHandler,
  type SnoozeArg,
} from "./_shared";

export const handleSnoozeCallback: CallbackHandler = async (context) => {
  const { db, cb, chatId, parsed, storedIntent } = context;
  // Sequence DB write BEFORE the ack so the toast reflects actual outcome.
  // A concurrent Promise.all would leave the ack in-flight if the write
  // rejects, and the Workers runtime can cancel the pending fetch once the
  // handler throws, producing silent snooze failures from the user's POV.
  await runCallbackMutation<{ duration: SnoozeArg; untilSec: number }>(context, {
    validate: () => {
      if (!hasExactParts(parsed.parts, 2) || !isSnoozeArg(parsed.arg)) return null;
      const untilSec = storedIntent?.kind === "callback:snooze"
        ? Number(storedIntent.payload.untilSec)
        : unixNow() + SNOOZE_SECONDS[parsed.arg];
      return Number.isFinite(untilSec) ? { duration: parsed.arg, untilSec } : null;
    },
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "chat",
    logAction: "snooze",
    logMessage: "snooze write failed",
    successOutcome: "set",
    write: async ({ untilSec }, options) =>
      setSubscriberSnooze(db, chatId, callbackUsername(cb), untilSec, options),
    successText: ({ duration }) => `All alerts paused for ${duration}. Use /list to verify.`,
    failureText: "Could not save snooze. Please try again.",
  });
};
