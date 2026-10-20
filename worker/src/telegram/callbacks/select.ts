import { parseDisambiguationReply } from "../common/alerts-parser";
import {
  loadPendingDisambiguation,
  unixNow,
} from "../store/telegram-webhook-store";
import {
  executeNormalizedPendingSelection,
  executePendingDisambiguationSelection,
  parseStoredCommandSelectionIntent,
} from "../store/telegram-webhook-disambiguation-selection";
import { parsePendingDisambiguation } from "../webhook/telegram-webhook-parsing";
import { isPendingFlowId } from "../webhook/telegram-webhook-shared";
import {
  callbackActorUserId,
  callbackUsername,
  hasExactParts,
  type CallbackHandler,
  requireAdminForMutatingCallback,
} from "./_shared";

export const handleSelectCallback: CallbackHandler = async (ctx) => {
  const { db, botToken, cb, chatId, parsed, answerCallback } = ctx;
  if (!hasExactParts(parsed.parts, 3) || !isPendingFlowId(parsed.parts[2])) {
    await answerCallback({ text: "This keyboard is no longer current. Re-run the command." });
    return;
  }
  const storedFlowId = ctx.storedIntent?.payload.sourceFlowId ?? ctx.storedIntent?.payload.flowId;
  if (ctx.storedIntent && storedFlowId !== parsed.parts[2]) {
    await answerCallback({ text: "This keyboard is no longer current. Re-run the command." });
    return;
  }
  const storedSelection = parseStoredCommandSelectionIntent(ctx.storedIntent);
  if (storedSelection) {
    if (!isPendingFlowId(storedSelection.flowId) || storedSelection.flowId !== parsed.parts[2]) {
      await answerCallback({ text: "This keyboard is no longer current. Re-run the command." });
      return;
    }
    const actorUserId = callbackActorUserId(cb);
    if (storedSelection.initiatorUserId != null && storedSelection.initiatorUserId !== actorUserId) {
      await answerCallback({ text: "Only the user who started this selection can choose." });
      return;
    }
    if (!(await requireAdminForMutatingCallback(
      db, botToken, cb, chatId, undefined, ctx.beforeIrreversibleEffect,
    ))) return;
    await executeNormalizedPendingSelection(
      db,
      botToken,
      chatId,
      callbackUsername(cb),
      storedSelection,
      {
        beforeIrreversibleEffect: ctx.beforeIrreversibleEffect,
        planIntent: ctx.planIntent,
        prepareMutationAppliedStatement: ctx.prepareMutationAppliedStatement,
        confirmAtomicMutationApplied: ctx.confirmAtomicMutationApplied,
        markMutationApplied: ctx.markMutationApplied,
        storedIntent: ctx.storedIntent,
        wasMutationApplied: ctx.wasMutationApplied,
      },
    );
    await answerCallback({ text: "Selected." });
    return;
  }
  if (ctx.storedIntent) {
    await answerCallback({ text: "This keyboard is no longer current. Re-run the command." });
    return;
  }
  const pendingRow = await loadPendingDisambiguation(db, chatId);
  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    await answerCallback({ text: "Selection expired. Re-run the command." });
    return;
  }
  const pendingAction = parsePendingDisambiguation(pendingRow, parsed.parts[2]);
  if (
    !pendingAction
    || pendingAction.actionType === "setup-step"
    || pendingAction.actionType === "confirm-bulk"
    || pendingAction.actionType === "forget-confirm"
  ) {
    await answerCallback({ text: "No current ticker selection is pending. Re-run the command." });
    return;
  }
  if (!isPendingFlowId(pendingAction.flowId) || pendingAction.flowId !== parsed.parts[2]) {
    await answerCallback({ text: "This keyboard is no longer current. Re-run the command." });
    return;
  }
  const actorUserId = callbackActorUserId(cb);
  if (pendingAction.initiatorUserId != null && pendingAction.initiatorUserId !== actorUserId) {
    await answerCallback({ text: "Only the user who started this selection can choose." });
    return;
  }
  const selectedIndices = parseDisambiguationReply(parsed.arg ?? "", pendingAction.candidates.length);
  if (!selectedIndices) {
    await answerCallback({ text: "Selection not recognized." });
    return;
  }
  if (!(await requireAdminForMutatingCallback(
    db, botToken, cb, chatId, undefined, ctx.beforeIrreversibleEffect,
  ))) return;
  await executePendingDisambiguationSelection(
    db,
    botToken,
    chatId,
    callbackUsername(cb),
    pendingAction,
    selectedIndices,
    {
      beforeIrreversibleEffect: ctx.beforeIrreversibleEffect,
      planIntent: ctx.planIntent,
      prepareMutationAppliedStatement: ctx.prepareMutationAppliedStatement,
      confirmAtomicMutationApplied: ctx.confirmAtomicMutationApplied,
      markMutationApplied: ctx.markMutationApplied,
      storedIntent: ctx.storedIntent,
      wasMutationApplied: ctx.wasMutationApplied,
    },
  );
  await answerCallback({ text: "Selected." });
};
