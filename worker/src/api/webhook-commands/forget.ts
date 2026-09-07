import { recordTelegramUsageEvent } from "../../lib/telegram/usage-analytics";
import { buildTelegramMiniAppUrl } from "../../lib/telegram/webhook-registration";
import { MINI_APP_PAYLOAD_NAMES } from "@shared/lib/telegram-mini-app-payloads";
import {
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  persistPendingForgetConfirm,
} from "../telegram-webhook-store";
import type { WebhookCommandHandler } from "./context";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import { DISAMBIGUATION_TTL_SEC } from "../telegram-webhook-shared";

/**
 * Inline keyboard markup for the `/forget` two-step confirmation. Mirrors the
 * `BULK_CONFIRM_REPLY_MARKUP` shape used by `/subscribe all` so the callback
 * shares the existing `confirm:`/`cancel:` action namespace.
 */
const FORGET_CONFIRM_REPLY_MARKUP = {
  inline_keyboard: [
    [{ text: "Open control panel", web_app: { url: buildTelegramMiniAppUrl(MINI_APP_PAYLOAD_NAMES.forget) } }],
    [
      { text: "Confirm", callback_data: "confirm:forget" },
      { text: "Cancel", callback_data: "cancel:forget" },
    ],
  ],
} as const;

const FORGET_CONFIRM_MESSAGE = [
  "This will permanently delete your Pharos subscriber data:",
  "- all coin and preset subscriptions",
  "- global alert toggles and quiet hours",
  "- delivery diagnostics and any pending alerts",
  "",
  "Pharos will retain only:",
  "- acknowledged Telegram updates (for idempotency)",
  "- delivery audit manifests (alert-job and dead-letter rows)",
  "- privacy-preserving aggregate counters",
  "",
  "Confirm to proceed.",
].join("\n");

export const handleForget: WebhookCommandHandler = async (ctx) => {
  if (ctx.chatType !== "private") {
    await ctx.replyToChat("Open a private chat with PharosWatchBot to delete your data.");
    await recordTelegramUsageEvent(ctx.db, {
      eventType: "command_forget",
      actionDetail: "command",
      outcome: "failure",
      failureClass: "not_private",
    });
    return;
  }

  const storedExpiresAt = Number(ctx.storedIntent?.payload.expiresAt);
  const expiresAt = Number.isFinite(storedExpiresAt)
    ? storedExpiresAt
    : (ctx.operationNowSec ?? Math.floor(Date.now() / 1000)) + DISAMBIGUATION_TTL_SEC;
  await ctx.planIntent?.(createTelegramWebhookIntent("command:forget", {
    stage: "forget-confirm-prompt",
    expiresAt,
    clearPending: Boolean(ctx.clearPendingOnMutation),
  }, "required"));
  const actionPayload = "{}";
  const operationStatements = ctx.preparePendingMutationAppliedStatement
    ? [ctx.preparePendingMutationAppliedStatement({
        chatId: ctx.chatId,
        actionType: "forget-confirm",
        actionPayload,
        expiresAt,
      })]
    : undefined;
  const persisted = ctx.wasMutationApplied
    ? true
    : await persistPendingForgetConfirm(ctx.db, {
        chatId: ctx.chatId,
        initiatorUserId: ctx.actorUserId,
        expiresAt,
        operationStatements,
      });
  if (!persisted) {
    await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
    return;
  }
  if (!ctx.wasMutationApplied && operationStatements) ctx.confirmAtomicMutationApplied?.();

  await ctx.replyToChatWithMarkup(FORGET_CONFIRM_MESSAGE, {
    replyMarkup: FORGET_CONFIRM_REPLY_MARKUP,
  });
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "command_forget",
    actionDetail: "command",
    outcome: "prompted",
  });
};
