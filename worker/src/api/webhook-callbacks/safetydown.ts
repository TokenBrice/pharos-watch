import { batchExecute } from "../../lib/db";
import { prepareCoinSettingStatements } from "../telegram-webhook-settings-mutations";
import {
  callbackUsername,
  hasExactParts,
  isSubscribableStablecoinId,
  runCallbackMutation,
  type CallbackHandler,
} from "./_shared";

export const handleSafetyDownCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  await runCallbackMutation<string>({
    db,
    botToken,
    cb,
    chatId,
    validate: () =>
      hasExactParts(parsed.parts, 2) && isSubscribableStablecoinId(parsed.arg) ? parsed.arg : null,
    requireAdmin: true,
    eventType: "subscribe",
    actionDetail: "safetydown",
    logAction: "safetydown",
    logMessage: "safetydown callback write failed",
    write: async (id) => {
      const prepared = prepareCoinSettingStatements(
        db,
        chatId,
        callbackUsername(cb),
        id,
        "sm",
        "d",
      );
      await batchExecute(db, prepared.statements);
    },
    successText: "Safety alerts set to downgrades only.",
    failureText: "Could not save setting. Please try again.",
  });
};
