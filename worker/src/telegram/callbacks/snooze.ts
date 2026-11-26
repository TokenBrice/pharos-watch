import { PAUSE_SENTINEL_TS } from "@shared/lib/telegram-delivery-policy";
import { clearAlertSnooze, setSubscriberSnooze } from "../store/snooze";
import { unixNow } from "../store/subscribers";
import { cmdForChat } from "../webhook/telegram-webhook-messages";
import {
  callbackChatType,
  callbackUsername,
  hasExactParts,
  isSnoozeArg,
  runCallbackMutation,
  SNOOZE_SECONDS,
  type CallbackHandler,
  type SnoozeArg,
} from "./_shared";

type SnoozeCallbackAction =
  | { kind: "timed"; duration: SnoozeArg; untilSec: number }
  | { kind: "pause"; untilSec: number }
  | { kind: "off" };

export const handleSnoozeCallback: CallbackHandler = async (context) => {
  const { db, cb, chatId, parsed } = context;
  const chatType = callbackChatType(cb);
  const isPrivate = chatType === "private";
  const resumeHint = isPrivate
    ? "Resume in Manage Alerts."
    : `Resume with ${cmdForChat("pause", chatType)} off.`;
  // Sequence DB write BEFORE the ack so the toast reflects actual outcome.
  // A concurrent Promise.all would leave the ack in-flight if the write
  // rejects, and the Workers runtime can cancel the pending fetch once the
  // handler throws, producing silent snooze failures from the user's POV.
  await runCallbackMutation<SnoozeCallbackAction>(context, {
    validate: () => {
      if (!hasExactParts(parsed.parts, 2)) return null;
      if (parsed.arg === "off") return { kind: "off" };
      if (parsed.arg === "pause") return { kind: "pause", untilSec: PAUSE_SENTINEL_TS };
      if (!isSnoozeArg(parsed.arg)) return null;
      const untilSec = unixNow() + SNOOZE_SECONDS[parsed.arg];
      return Number.isFinite(untilSec) ? { kind: "timed", duration: parsed.arg, untilSec } : null;
    },
    requireAdmin: true,
    eventType: "snooze_change",
    actionDetail: "chat",
    logAction: "snooze",
    logMessage: "snooze write failed",
    successOutcome: parsed.arg === "off" ? "cleared" : parsed.arg === "pause" ? "enabled" : "set",
    write: async (action, options) => {
      if (action.kind === "off") {
        await clearAlertSnooze(db, chatId, callbackUsername(cb), options);
        return;
      }
      await setSubscriberSnooze(db, chatId, callbackUsername(cb), action.untilSec, options);
    },
    successText: (action) => {
      if (action.kind === "off") return "Alerts resumed.";
      if (action.kind === "pause") return `All alerts paused until you resume. ${resumeHint}`;
      return `All alerts paused for ${action.duration}. ${resumeHint}`;
    },
    failureText: "Could not save snooze. Please try again.",
  });
};
