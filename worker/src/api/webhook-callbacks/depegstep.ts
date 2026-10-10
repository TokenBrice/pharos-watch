import { executeAtomicBatch } from "../../lib/db";
import { isDepegStepValue } from "../../lib/telegram/constants";
import { prepareCoinSettingStatements } from "../telegram-webhook-settings-mutations";
import {
  callbackUsername,
  hasExactParts,
  isSubscribableStablecoinId,
  runCallbackMutation,
  type CallbackHandler,
} from "./_shared";

export const handleDepegStepCallback: CallbackHandler = async (context) => {
  const { db, cb, chatId, parsed } = context;
  await runCallbackMutation<{ id: string; step: number }>(context, {
    validate: () => {
      const step = Number(parsed.parts[2]);
      if (
        !hasExactParts(parsed.parts, 3) ||
        !isSubscribableStablecoinId(parsed.arg) ||
        !isDepegStepValue(step)
      ) {
        return null;
      }
      return { id: parsed.arg, step };
    },
    requireAdmin: true,
    eventType: "subscribe",
    actionDetail: "depegstep",
    logAction: "depegstep",
    logMessage: "depegstep callback write failed",
    intentKind: "callback:depegstep",
    intentPayload: ({ id, step }) => ({ coinId: id, step }),
    write: async ({ id, step }, options) => {
      const prepared = prepareCoinSettingStatements(
        db,
        chatId,
        callbackUsername(cb),
        id,
        "ds",
        String(step),
      );
      await executeAtomicBatch(db, [...prepared.statements, ...(options.operationStatements ?? [])]);
    },
    successText: ({ step }) => `Depeg worsening alerts set to ${step} bps.`,
    failureText: "Could not save setting. Please try again.",
  });
};
