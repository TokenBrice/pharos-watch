import { logTelegramEvent } from "../common/log";
import { recordTelegramUsageEvent } from "../store/usage-analytics";
import {
  applySubscribeIntent,
  applyUnsubscribeIntent,
  clearPendingDisambiguation,
  forgetSubscriber,
  loadPendingDisambiguation,
  unixNow,
  unsubscribeAll,
  upsertGlobalAlertTypes,
} from "../store/telegram-webhook-store";
import { parsePendingDisambiguation, parseStoredConfirmBulkPayload } from "../webhook/telegram-webhook-parsing";
import { sendAuditedTelegramReply } from "../webhook/telegram-webhook-replies";
import { createTelegramWebhookIntent } from "../webhook/telegram-webhook-effect-fence";
import type { ConfirmBulkPayload } from "../webhook/telegram-webhook-shared";
import { isPendingFlowId } from "../webhook/telegram-webhook-shared";
import {
  callbackChatType,
  callbackUsername,
  hasExactParts,
  requireAdminForMutatingCallback,
  type CallbackContext,
  type CallbackHandler,
} from "./_shared";

type ConfirmationKind = "bulk" | "forget";
type ConfirmationAction = "confirm" | "cancel";

interface NormalizedConfirmation {
  action: ConfirmationAction;
  kind: ConfirmationKind;
  expiresAt: number;
  flowId: string;
  payload: ConfirmBulkPayload | null;
}

function parseStoredConfirmation(ctx: CallbackContext): NormalizedConfirmation | null {
  const intent = ctx.storedIntent;
  if (!intent || intent.kind !== `callback:${ctx.parsed.action}` || intent.mutation !== "required") return null;
  const { action, kind, expiresAt, payload, flowId } = intent.payload;
  if (
    (action !== "confirm" && action !== "cancel")
    || (kind !== "bulk" && kind !== "forget")
    || typeof expiresAt !== "number"
    || !isPendingFlowId(flowId)
    || flowId !== ctx.parsed.parts[2]
  ) {
    return null;
  }
  if (kind === "forget") return { action, kind, expiresAt, flowId, payload: null };
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) return null;
  const bulk = parseStoredConfirmBulkPayload(payload as Record<string, unknown>);
  return bulk ? { action, kind, expiresAt, flowId, payload: bulk } : null;
}

async function loadFreshConfirmation(
  ctx: CallbackContext,
  action: ConfirmationAction,
  kind: ConfirmationKind,
): Promise<NormalizedConfirmation | null> {
  const pendingRow = await loadPendingDisambiguation(ctx.db, ctx.chatId);
  if (!pendingRow || unixNow() >= pendingRow.expires_at) {
    await ctx.answerCallback({
      text: kind === "forget"
        ? "This confirmation has expired. Re-run /forget."
        : "This confirmation has expired. Re-run the command.",
    });
    return null;
  }
  const pending = parsePendingDisambiguation(pendingRow, ctx.parsed.parts[2]);
  const expectedType = kind === "forget" ? "forget-confirm" : "confirm-bulk";
  if (!pending || pending.actionType !== expectedType) {
    await ctx.answerCallback({
      text: kind === "forget" ? "No forget confirmation is pending. Re-run /forget." : "This confirmation has expired. Re-run the command.",
    });
    return null;
  }
  if (!isPendingFlowId(pending.flowId) || pending.flowId !== ctx.parsed.parts[2]) {
    await ctx.answerCallback({ text: "This keyboard is no longer current. Re-run the command." });
    return null;
  }
  const actorUserId = ctx.cb.from?.id != null ? String(ctx.cb.from.id) : null;
  if (pending.initiatorUserId != null && pending.initiatorUserId !== actorUserId) {
    await ctx.answerCallback({ text: "Only the user who started this confirmation can complete it." });
    return null;
  }
  return {
    action,
    kind,
    expiresAt: pendingRow.expires_at,
    flowId: pending.flowId,
    payload: pending.actionType === "confirm-bulk" ? pending.payload : null,
  };
}

async function executeConfirmedBulk(
  ctx: CallbackContext,
  payload: ConfirmBulkPayload,
  operationStatements?: D1PreparedStatement[],
): Promise<void> {
  if (payload.kind === "subscribe") {
    const alertTypes = new Set(payload.alertTypes);
    if (payload.subscribeAll) {
      await upsertGlobalAlertTypes(ctx.db, ctx.chatId, callbackUsername(ctx.cb), alertTypes, {
        clearPending: true,
        operationStatements,
      });
    } else {
      await applySubscribeIntent(ctx.db, {
        chatId: ctx.chatId,
        username: callbackUsername(ctx.cb),
        alertTypes,
        directStablecoinIds: payload.coinIds,
        presetIds: payload.presetIds,
        clearPending: true,
        depegWorseningBpsStep: payload.depegWorseningBpsStep,
        operationStatements,
      });
    }
    await recordTelegramUsageEvent(ctx.db, {
      eventType: "subscribe",
      actionDetail: payload.subscribeAll ? "all" : payload.presetIds.length > 0 ? "preset" : "coin",
      outcome: "success",
    });
    return;
  }
  if (payload.unsubscribeAll) {
    await unsubscribeAll(ctx.db, ctx.chatId, { clearPending: true, operationStatements });
  } else if (payload.kind === "unsubscribe") {
    await applyUnsubscribeIntent(ctx.db, {
      chatId: ctx.chatId,
      directStablecoinIds: payload.coinIds,
      presetIds: payload.presetIds,
      clearPending: true,
      operationStatements,
    });
  }
  await recordTelegramUsageEvent(ctx.db, {
    eventType: "unsubscribe",
    actionDetail: payload.unsubscribeAll ? "all" : payload.presetIds.length > 0 ? "preset" : "coin",
    outcome: "success",
  });
}

async function applyConfirmation(ctx: CallbackContext, normalized: NormalizedConfirmation): Promise<void> {
  await ctx.planIntent?.(createTelegramWebhookIntent(`callback:${normalized.action}`, {
    action: normalized.action,
    kind: normalized.kind,
    expiresAt: normalized.expiresAt,
    flowId: normalized.flowId,
    payload: normalized.payload,
  }, "required"));
  if (!ctx.wasMutationApplied) {
    const operationStatements = ctx.prepareMutationAppliedStatement
      ? [ctx.prepareMutationAppliedStatement()]
      : undefined;
    if (normalized.action === "cancel") {
      await clearPendingDisambiguation(ctx.db, ctx.chatId, {
        expected: {
          actionType: normalized.kind === "forget" ? "forget-confirm" : "confirm-bulk",
          expiresAt: normalized.expiresAt,
          actionPayload: JSON.stringify(normalized.payload ?? { flowId: normalized.flowId }),
        },
        operationStatements,
      });
    } else if (normalized.kind === "forget") {
      await forgetSubscriber(ctx.db, ctx.chatId, { operationStatements });
    } else if (normalized.payload) {
      await executeConfirmedBulk(ctx, normalized.payload, operationStatements);
    }
    if (operationStatements) ctx.confirmAtomicMutationApplied?.();
    // The fallback exists for direct tests without an update_id claim; normal
    // webhook dispatch always commits a prepared marker with the domain write.
    else await ctx.markMutationApplied();
  }

  const reply = normalized.action === "cancel"
    ? "Cancelled."
    : normalized.kind === "forget"
      ? "Your subscriber data has been deleted. Use /start to begin again."
      : "Confirmed.";
  await ctx.beforeIrreversibleEffect(normalized.kind === "forget" ? "callback-forget-reply" : "callback-bulk-reply");
  await sendAuditedTelegramReply(ctx.db, ctx.chatId, reply, ctx.botToken, {
    actionDetail: normalized.kind === "forget" ? "callback_forget" : "callback_bulk",
    ...(normalized.kind === "forget" ? { recordReplyOutcome: false } : {}),
  });
  await ctx.answerCallback({
    text: normalized.action === "cancel"
      ? "Cancelled."
      : normalized.kind === "forget"
        ? "Deleted."
        : "Applied.",
  });
}

export const handleBulkActionCallback: CallbackHandler = async (ctx) => {
  const { parsed } = ctx;
  if (parsed.parts.length === 2) {
    await ctx.answerCallback({ text: "This keyboard is no longer current. Re-run the command." });
    return;
  }
  if (
    (parsed.action !== "confirm" && parsed.action !== "cancel")
    || !hasExactParts(parsed.parts, 3)
    || !isPendingFlowId(parsed.parts[2])
    || (parsed.arg !== "bulk" && parsed.arg !== "forget")
  ) {
    await ctx.answerCallback({ text: "Action not recognized." });
    return;
  }
  if (parsed.arg === "forget" && callbackChatType(ctx.cb) !== "private") {
    await ctx.answerCallback({ text: "Open a private chat with PharosWatchBot." });
    return;
  }
  if (
    parsed.arg === "bulk"
    && !(await requireAdminForMutatingCallback(
      ctx.db,
      ctx.botToken,
      ctx.cb,
      ctx.chatId,
      undefined,
      ctx.beforeIrreversibleEffect,
    ))
  ) {
    return;
  }

  const normalized = ctx.storedIntent
    ? parseStoredConfirmation(ctx)
    : await loadFreshConfirmation(ctx, parsed.action, parsed.arg);
  if (!normalized) {
    if (ctx.storedIntent) await ctx.answerCallback({ text: "This confirmation has expired. Re-run the command." });
    return;
  }
  try {
    await applyConfirmation(ctx, normalized);
  } catch (err) {
    logTelegramEvent({
      message: "confirmation callback failed",
      action: normalized.kind === "forget" ? "forget-confirm" : "confirm-bulk",
    });
    throw err;
  }
};
