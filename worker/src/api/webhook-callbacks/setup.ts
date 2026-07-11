import { answerCallbackQuery } from "../../lib/telegram";
import { loadPendingDisambiguation, unixNow } from "../telegram-webhook-store";
import {
  handleSetupBranch,
  handleSetupCancel,
  handleSetupConfirm,
  handleSetupNext,
  handleSetupTarget,
  handleSetupTypeToggle,
  parseSetupState,
} from "../telegram-webhook-setup";
import { SETUP_PENDING_ACTION_TYPE } from "../telegram-webhook-shared";
import type { TelegramWebhookOperationIntent } from "../telegram-webhook-store";
import {
  callbackActorUserId,
  callbackUsername,
  hasExactParts,
  requireAdminForMutatingCallback,
  type ParsedCallbackData,
  type TelegramCallbackQuery,
} from "./_shared";

/**
 * Bespoke pre-dispatch entry for `setup:*` callbacks. Lives outside the
 * `CALLBACK_HANDLERS` map (and outside `CALLBACK_ACTIONS`) because the
 * sub-action grammar is `setup:<branch|type-toggle|target|next|confirm|cancel>`
 * with action-specific arity; it needs earlier access to D1 (loading
 * pending-disambiguation state) than the registry-driven path.
 */
export async function handleSetupCallback(
  db: D1Database,
  botToken: string,
  cb: TelegramCallbackQuery,
  chatId: string,
  parsed: ParsedCallbackData,
  effectInput: {
    beforeIrreversibleEffect: (kind: string) => Promise<void>;
    planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
    prepareMutationAppliedStatement?: () => D1PreparedStatement;
    confirmAtomicMutationApplied?: () => void;
    storedIntent?: TelegramWebhookOperationIntent | null;
    wasMutationApplied?: boolean;
  } | ((kind: string) => Promise<void>) = async () => undefined,
): Promise<void> {
  const effect = typeof effectInput === "function"
    ? { beforeIrreversibleEffect: effectInput }
    : effectInput;
  const { beforeIrreversibleEffect } = effect;
  const answer = async (text: string): Promise<void> => {
    await beforeIrreversibleEffect("callback-ack");
    await answerCallbackQuery(cb.id, botToken, { text });
  };
  const { arg: subAction = "", parts } = parsed;
  const subArg = parts[2] ?? "";
  const validSetupCallback =
    (subAction === "branch" && hasExactParts(parts, 3) && (subArg === "recommended" || subArg === "custom" || subArg === "skip")) ||
    (subAction === "type-toggle" && hasExactParts(parts, 3)) ||
    (subAction === "target" && hasExactParts(parts, 3)) ||
    ((subAction === "next" || subAction === "confirm" || subAction === "cancel") && parts.length === 2);
  if (!validSetupCallback) {
    await answer("Action not recognized.");
    return;
  }
  const mutatingSetupCallback = !(subAction === "cancel" || (subAction === "branch" && subArg === "skip"));
  if (mutatingSetupCallback && !(await requireAdminForMutatingCallback(
    db,
    botToken,
    cb,
    chatId,
    undefined,
    beforeIrreversibleEffect,
  ))) {
    return;
  }

  const stateRow = await loadPendingDisambiguation(db, chatId);
  const isActiveSetup =
    stateRow?.action_type === SETUP_PENDING_ACTION_TYPE && unixNow() < stateRow.expires_at;
  const state = isActiveSetup
    ? parseSetupState(stateRow?.action_payload ?? null, stateRow?.initiator_user_id ?? null)
    : null;
  const context = {
    db,
    botToken,
    chatId,
    actorUserId: callbackActorUserId(cb),
    username: callbackUsername(cb),
    beforeIrreversibleEffect,
    planIntent: effect.planIntent,
    prepareMutationAppliedStatement: effect.prepareMutationAppliedStatement,
    confirmAtomicMutationApplied: effect.confirmAtomicMutationApplied,
    storedIntent: effect.storedIntent,
    wasMutationApplied: effect.wasMutationApplied,
  };

  let result: { text: string };
  if (subAction === "branch") {
    result = await handleSetupBranch(context, subArg, state);
  } else if (subAction === "type-toggle") {
    result = await handleSetupTypeToggle(context, subArg, state);
  } else if (subAction === "next") {
    result = await handleSetupNext(context, state);
  } else if (subAction === "target") {
    result = await handleSetupTarget(context, subArg, state);
  } else if (subAction === "confirm") {
    result = await handleSetupConfirm(context, state);
  } else if (subAction === "cancel") {
    result = await handleSetupCancel(context, state);
  } else {
    result = { text: "Action not recognized." };
  }

  await answer(result.text);
}
