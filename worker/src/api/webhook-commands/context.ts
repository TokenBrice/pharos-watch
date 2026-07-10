import type { TelegramWebhookOperationIntent } from "../telegram-webhook-store";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";

/**
 * Shared context passed to every command handler in the Telegram webhook
 * dispatch table. Handlers receive the runtime dependencies they may need; not
 * every handler uses every field. Reply helpers are bound to the active chat
 * to keep call sites short.
 */
export interface WebhookCommandContext {
  db: D1Database;
  chatId: string;
  chatType: string;
  username: string | null;
  actorUserId: string | null;
  botToken: string;
  /** Stable timestamp captured when the operation was normalized. */
  operationNowSec?: number;
  /** Crosses the at-most-once boundary immediately before a Bot API effect. */
  beforeIrreversibleEffect?: (kind: string) => Promise<void>;
  planIntent?: (intent: TelegramWebhookOperationIntent) => Promise<void>;
  prepareMutationAppliedStatement?: () => D1PreparedStatement;
  prepareMutationOperationStatements?: () => D1PreparedStatement[];
  preparePendingMutationAppliedStatement?: (input: {
    chatId: string;
    actionType: string;
    actionPayload: string;
    expiresAt: number;
  }) => D1PreparedStatement;
  confirmAtomicMutationApplied?: () => void;
  markMutationApplied?: () => Promise<void>;
  storedIntent?: TelegramWebhookOperationIntent | null;
  wasMutationApplied?: boolean;
  /** Fold replacement of an active pending flow into this command's mutation batch. */
  clearPendingOnMutation?: boolean;
  /** Sends a plain text message to the originating chat. */
  replyToChat: (message: string) => Promise<void>;
  /** Sends a message with an optional inline keyboard / reply markup. */
  replyToChatWithMarkup: (
    message: string,
    options: { replyMarkup?: unknown },
  ) => Promise<void>;
}

export type WebhookCommandHandler = (
  ctx: WebhookCommandContext,
  args: string,
) => Promise<void>;

export async function prepareCommandMutation(
  ctx: WebhookCommandContext,
  command: string,
  payload: Record<string, unknown>,
): Promise<{ operationStatements?: D1PreparedStatement[] }> {
  await ctx.planIntent?.(createTelegramWebhookIntent(`command:${command}`, {
    ...payload,
    clearPending: Boolean(ctx.clearPendingOnMutation),
  }, "required"));
  const operationStatements = ctx.prepareMutationOperationStatements?.()
    ?? (ctx.prepareMutationAppliedStatement ? [ctx.prepareMutationAppliedStatement()] : undefined);
  return { operationStatements };
}

export function confirmCommandMutation(
  ctx: WebhookCommandContext,
  operation: { operationStatements?: D1PreparedStatement[] },
): void {
  if (operation.operationStatements) ctx.confirmAtomicMutationApplied?.();
}

/**
 * Sends `message`, attaching the mini-app `markup` only in private chats. In
 * group/supergroup chats the inline mini-app keyboard is omitted (Telegram
 * mini-apps are DM-only), so the plain reply is used instead.
 */
export async function replyWithOptionalMiniApp(
  ctx: WebhookCommandContext,
  message: string,
  markup: unknown,
): Promise<void> {
  if (ctx.chatType === "private") {
    await ctx.replyToChatWithMarkup(message, { replyMarkup: markup });
    return;
  }
  await ctx.replyToChat(message);
}
