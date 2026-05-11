import { parseStartPayload } from "../telegram-webhook-parsing";
import { sendWizardIntro } from "../telegram-webhook-setup";
import { START_MESSAGE } from "../telegram-webhook-shared";
import { isGroupAdminActor, isGroupChatType } from "../telegram-webhook-auth";
import type { WebhookCommandHandler } from "./context";
import { handleSubscribe } from "./subscribe";
import { handleStatus } from "./status";
import { handleWhy } from "./why";
import { handleCoverage } from "./coverage";

export const handleStart: WebhookCommandHandler = async (ctx, args) => {
  const payload = parseStartPayload(args);
  switch (payload.kind) {
    case "subscribe":
      if (ctx.chatType !== "private") {
        await ctx.replyToChat(START_MESSAGE);
        return;
      }
      await handleSubscribe(ctx, payload.args);
      return;
    case "status":
      await handleStatus(ctx, payload.coinId);
      return;
    case "why":
      await handleWhy(ctx, payload.coinId);
      return;
    case "coverage":
      await handleCoverage(ctx, payload.coinId);
      return;
    case "setup":
    case "none":
      if (
        isGroupChatType(ctx.chatType) &&
        !(await isGroupAdminActor(ctx.db, ctx.botToken, ctx.chatId, ctx.actorUserId))
      ) {
        await ctx.replyToChat(START_MESSAGE);
        return;
      }
      // Empty payload or `?start=setup` both open the wizard in private chats
      // and for group admins. Non-admin group members get the read-only start
      // message above.
      await sendWizardIntro(ctx.db, ctx.botToken, ctx.chatId, ctx.actorUserId);
      return;
  }
};
