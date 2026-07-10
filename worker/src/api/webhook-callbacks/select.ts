import { parseDisambiguationReply } from "../../lib/telegram-alerts";
import {
  loadPendingDisambiguation,
  unixNow,
} from "../telegram-webhook-store";
import {
  executeNormalizedPendingSelection,
  executePendingDisambiguationSelection,
  parseStoredCommandSelectionIntent,
} from "../telegram-webhook-disambiguation-selection";
import { parsePendingDisambiguation } from "../telegram-webhook-parsing";
import {
  callbackActorUserId,
  callbackUsername,
  hasExactParts,
  type CallbackHandler,
} from "./_shared";

export const handleSelectCallback: CallbackHandler = async (ctx) => {
  const { db, botToken, cb, chatId, parsed, answerCallback } = ctx;
  if (!hasExactParts(parsed.parts, 2)) {
    await answerCallback({ text: "Action not recognized." });
    return;
  }
  const storedSelection = parseStoredCommandSelectionIntent(ctx.storedIntent);
  if (storedSelection) {
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
  const pendingRow = await loadPendingDisambiguation(db, chatId);
  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    await answerCallback({ text: "Selection expired. Re-run the command." });
    return;
  }
  const pendingAction = parsePendingDisambiguation(pendingRow);
  if (
    !pendingAction
    || pendingAction.actionType === "setup-step"
    || pendingAction.actionType === "confirm-bulk"
    || pendingAction.actionType === "forget-confirm"
  ) {
    await answerCallback({ text: "No ticker selection is pending." });
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
