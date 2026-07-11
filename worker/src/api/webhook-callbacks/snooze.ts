import { setSubscriberSnooze, unixNow } from "../telegram-webhook-store";
import {
  callbackUsername,
  hasExactParts,
  isSnoozeArg,
  runCallbackMutation,
  SNOOZE_SECONDS,
  type CallbackHandler,
  type SnoozeArg,
} from "./_shared";

export const handleSnoozeCallback: CallbackHandler = async ({
  db, botToken, cb, chatId, parsed, answerCallback, beforeIrreversibleEffect,
  markMutationApplied, planIntent, prepareMutationAppliedStatement, confirmAtomicMutationApplied,
  storedIntent, wasMutationApplied,
}) => {
  // Sequence DB write BEFORE the ack so the toast reflects actual outcome.
  // A concurrent Promise.all would leave the ack in-flight if the write
  // rejects, and the Workers runtime can cancel the pending fetch once the
  // handler throws, producing silent snooze failures from the user's POV.
  await runCallbackMutation<{ duration: SnoozeArg; untilSec: number }>({
    db,
    botToken,
    cb,
    chatId,
    validate: () => hasExactParts(parsed.parts, 2) && isSnoozeArg(parsed.arg)
      ? {
          duration: parsed.arg,
          untilSec: storedIntent?.kind === "callback:snooze"
            ? Number(storedIntent.payload.untilSec)
            : unixNow() + SNOOZE_SECONDS[parsed.arg],
        }
      : null,
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "chat",
    logAction: "snooze",
    logMessage: "snooze write failed",
    successOutcome: "set",
    intentKind: "callback:snooze",
    intentPayload: ({ duration, untilSec }) => ({ duration, untilSec }),
    write: async ({ untilSec }, options) =>
      setSubscriberSnooze(db, chatId, callbackUsername(cb), untilSec, options),
    successText: ({ duration }) => `Snoozed for ${duration}. Use /list to verify or tap a longer window.`,
    failureText: "Could not save snooze. Please try again.",
    answerCallback,
    beforeIrreversibleEffect,
    markMutationApplied,
    planIntent,
    prepareMutationAppliedStatement,
    confirmAtomicMutationApplied,
    wasMutationApplied,
  });
};
