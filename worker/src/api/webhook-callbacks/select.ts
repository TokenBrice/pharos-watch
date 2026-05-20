import { answerCallbackQuery } from "../../lib/telegram";
import {
  parseDisambiguationReply,
  type ResolvedCoin,
} from "../../lib/telegram-alerts";
import {
  clearPendingDisambiguation,
  loadPendingDisambiguation,
  unixNow,
} from "../telegram-webhook-store";
import { dedupeCoins, parsePendingDisambiguation } from "../telegram-webhook-parsing";
import type { PendingAction } from "../telegram-webhook-shared";
import { makeActionRunner } from "../webhook-commands/action-runner";
import {
  callbackActorUserId,
  callbackUsername,
  hasExactParts,
  type CallbackHandler,
} from "./_shared";

async function executePendingDisambiguationSelection(
  db: D1Database,
  botToken: string,
  chatId: string,
  username: string | null,
  pending: Exclude<PendingAction, { actionType: "confirm-bulk" | "forget-confirm" }>,
  selectedIndices: readonly number[],
): Promise<void> {
  const selectedCoins = dedupeCoins(
    selectedIndices.map((index) => pending.candidates[index]).filter((coin): coin is ResolvedCoin => Boolean(coin)),
  );
  const initialCoins = dedupeCoins([...pending.resolvedCoins, ...selectedCoins]);
  const sharedOpts = { tickers: pending.remainingTickers, initialCoins, clearPendingOnTerminal: true as const };

  switch (pending.actionType) {
    case "subscribe": {
      const runAction = makeActionRunner(
        { db, chatId, username, initiatorUserId: pending.initiatorUserId },
        botToken,
        {
          kind: "subscribe",
          alertTypes: [...pending.alertTypes],
          presetIds: pending.presetIds,
          depegWorseningBpsStep: pending.depegWorseningBpsStep,
        },
      );
      await runAction({
        ...sharedOpts,
        actionType: "subscribe",
        actionPayload: {
          alertTypes: [...pending.alertTypes],
          presetIds: pending.presetIds,
          depegWorseningBpsStep: pending.depegWorseningBpsStep,
        },
        alertTypes: pending.alertTypes,
      });
      return;
    }
    case "unsubscribe": {
      const runAction = makeActionRunner(
        { db, chatId, username: null, initiatorUserId: pending.initiatorUserId },
        botToken,
        { kind: "unsubscribe", presetIds: pending.presetIds },
      );
      await runAction({
        ...sharedOpts,
        actionType: "unsubscribe",
        actionPayload: { presetIds: pending.presetIds },
        resolutionScope: "tracked",
      });
      return;
    }
    case "set": {
      const runAction = makeActionRunner({ db, chatId, username, initiatorUserId: pending.initiatorUserId }, botToken);
      await runAction({ ...sharedOpts, actionType: "set", actionPayload: pending.command });
      return;
    }
  }
}

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
