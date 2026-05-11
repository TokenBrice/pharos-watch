import { escapeHtml } from "../../lib/telegram";
import {
  parseSubscribeArgs,
  resolveTicker,
  validateSubscribeArgs,
} from "../../lib/telegram-alerts";
import {
  buildNotFoundMessage,
  buildPresetUnavailableMessage,
} from "../telegram-webhook-messages";
import { persistPendingConfirmBulk } from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import {
  BULK_CONFIRM_REPLY_MARKUP,
  buildBulkConfirmMessage,
  dedupePresetIds,
  makeActionRunner,
  resolvePresetCoins,
  subscribableCoinCount,
} from "./action-runner";

export const handleSubscribe: WebhookCommandHandler = async (ctx, args) => {
  const { db, chatId, username, actorUserId } = ctx;
  const parsed = parseSubscribeArgs(args);
  const validationError = validateSubscribeArgs(parsed);
  if (validationError) {
    if (parsed.invalidTargets.length > 0 && parsed.alertTypes.size > 0) {
      const invalidTarget = parsed.invalidTargets[0];
      const match = resolveTicker(invalidTarget);
      const suggestion = match.status === "not_found" ? match.suggestion : undefined;
      await ctx.replyToChat(buildNotFoundMessage(invalidTarget, suggestion));
      return;
    }
    await ctx.replyToChat(escapeHtml(validationError));
    return;
  }

  if (parsed.subscribeAll) {
    await persistPendingConfirmBulk(db, {
      chatId,
      payload: {
        kind: "subscribe",
        alertTypes: [...parsed.alertTypes],
        presetIds: [],
        depegWorseningBpsStep: parsed.depegWorseningBpsStep,
        coinIds: [],
        subscribeAll: true,
      },
      initiatorUserId: actorUserId,
    });
    await ctx.replyToChatWithMarkup(
      buildBulkConfirmMessage("subscribe", subscribableCoinCount(), [...parsed.alertTypes], []),
      { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
    );
    return;
  }

  const presetIds = dedupePresetIds(parsed.presetIds);
  const presetCoins = await resolvePresetCoins(db, presetIds);
  if (presetCoins == null) {
    await ctx.replyToChat(buildPresetUnavailableMessage());
    return;
  }

  const runAction = makeActionRunner(
    { db, chatId, username, initiatorUserId: actorUserId },
    ctx.botToken,
    { kind: "subscribe", alertTypes: [...parsed.alertTypes], presetIds, depegWorseningBpsStep: parsed.depegWorseningBpsStep },
  );
  await runAction({
    tickers: parsed.tickers,
    initialCoins: presetCoins,
    actionType: "subscribe",
    actionPayload: {
      alertTypes: [...parsed.alertTypes],
      presetIds,
      depegWorseningBpsStep: parsed.depegWorseningBpsStep,
    },
    alertTypes: parsed.alertTypes,
  });
};
