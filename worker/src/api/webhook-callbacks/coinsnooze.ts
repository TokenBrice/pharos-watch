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

export const handleCoinSnoozeCallback: CallbackHandler = async ({
  db, botToken, cb, chatId, parsed, answerCallback, beforeIrreversibleEffect,
  markMutationApplied, planIntent, prepareMutationAppliedStatement, confirmAtomicMutationApplied,
  storedIntent, wasMutationApplied,
}) => {
  await runCallbackMutation<{ id: string; duration: SnoozeArg; untilSec: number }>({
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
      return {
        id: parsed.arg,
        duration: durationToken,
        untilSec: storedIntent?.kind === "callback:coinsnooze"
          ? Number(storedIntent.payload.untilSec)
          : unixNow() + SNOOZE_SECONDS[durationToken],
      };
    },
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "coin",
    logAction: "coinsnooze",
    logMessage: "coinsnooze write failed",
    successOutcome: "set",
    intentKind: "callback:coinsnooze",
    intentPayload: ({ id, duration, untilSec }) => ({ coinId: id, duration, untilSec }),
    write: async ({ id, untilSec }, options) =>
      setSubscriptionSnooze(db, chatId, id, untilSec, options),
    successText: ({ id, duration }) =>
      `Snoozed ${TRACKED_META_BY_ID.get(id)?.symbol ?? id} for ${duration}.`,
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
