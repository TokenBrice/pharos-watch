import { answerCallbackQuery } from "../../lib/telegram";
import { parseDisambiguationReply } from "../../lib/telegram-alerts";
import {
  clearPendingDisambiguation,
  loadPendingDisambiguation,
  unixNow,
} from "../telegram-webhook-store";
import { executePendingDisambiguationSelection } from "../telegram-webhook-disambiguation-selection";
import { parsePendingDisambiguation } from "../telegram-webhook-parsing";
import {
  callbackActorUserId,
  callbackUsername,
  hasExactParts,
  type CallbackHandler,
} from "./_shared";

export const handleSelectCallback: CallbackHandler = async ({ db, botToken, cb, chatId, parsed }) => {
  if (!hasExactParts(parsed.parts, 2)) {
    await answerCallbackQuery(cb.id, botToken, { text: "Action not recognized." });
    return;
  }
  const pendingRow = await loadPendingDisambiguation(db, chatId);
  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    if (pendingRow) await clearPendingDisambiguation(db, chatId);
    await answerCallbackQuery(cb.id, botToken, { text: "Selection expired. Re-run the command." });
    return;
  }
  const pendingAction = parsePendingDisambiguation(pendingRow);
  if (!pendingAction || pendingAction.actionType === "confirm-bulk" || pendingAction.actionType === "forget-confirm") {
    await answerCallbackQuery(cb.id, botToken, { text: "No ticker selection is pending." });
    return;
  }
  const actorUserId = callbackActorUserId(cb);
  if (pendingAction.initiatorUserId != null && pendingAction.initiatorUserId !== actorUserId) {
    await answerCallbackQuery(cb.id, botToken, { text: "Only the user who started this selection can choose." });
    return;
  }
  const selectedIndices = parseDisambiguationReply(parsed.arg ?? "", pendingAction.candidates.length);
  if (!selectedIndices) {
    await answerCallbackQuery(cb.id, botToken, { text: "Selection not recognized." });
    return;
  }
  await executePendingDisambiguationSelection(
    db,
    botToken,
    chatId,
    callbackUsername(cb),
    pendingAction,
    selectedIndices,
  );
  await answerCallbackQuery(cb.id, botToken, { text: "Selected." });
};
