import { logTelegramEvent } from "../../lib/telegram-log";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import {
  applySubscribeIntent,
  applyUnsubscribeIntent,
  clearPendingDisambiguation,
  forgetSubscriber,
  loadPendingDisambiguation,
  unixNow,
  unsubscribeAll,
  upsertGlobalAlertTypes,
  applyWatchlistImportV2,
  isWatchlistImportPreviewCurrent,
  watchlistPortableStateMatches,
} from "../telegram-webhook-store";
import { parsePendingDisambiguation, parseStoredConfirmBulkPayload } from "../telegram-webhook-parsing";
import { sendAuditedTelegramReply } from "../telegram-webhook-replies";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import type { ConfirmBulkPayload } from "../telegram-webhook-shared";
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
  payload: ConfirmBulkPayload | null;
}

function parseStoredConfirmation(ctx: CallbackContext): NormalizedConfirmation | null {
  const intent = ctx.storedIntent;
  if (!intent || intent.kind !== `callback:${ctx.parsed.action}` || intent.mutation !== "required") return null;
  const { action, kind, expiresAt, payload } = intent.payload;
  if (
    (action !== "confirm" && action !== "cancel")
    || (kind !== "bulk" && kind !== "forget")
    || typeof expiresAt !== "number"
  ) {
    return null;
  }
  if (kind === "forget") return { action, kind, expiresAt, payload: null };
  if (typeof payload !== "object" || payload == null || Array.isArray(payload)) return null;
  const bulk = parseStoredConfirmBulkPayload(payload as Record<string, unknown>);
  return bulk ? { action, kind, expiresAt, payload: bulk } : null;
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
  const pending = parsePendingDisambiguation(pendingRow);
  const expectedType = kind === "forget" ? "forget-confirm" : "confirm-bulk";
  if (!pending || pending.actionType !== expectedType) {
    await ctx.answerCallback({
      text: kind === "forget" ? "No forget confirmation is pending." : "No bulk confirmation is pending.",
    });
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
    payload: pending.actionType === "confirm-bulk" ? pending.payload : null,
  };
}

async function executeConfirmedBulk(
  ctx: CallbackContext,
  payload: ConfirmBulkPayload,
  expiresAt: number,
  operationStatements?: D1PreparedStatement[],
): Promise<"applied" | "stale"> {
  if (payload.kind === "watchlist-import-v2") {
    const previewCurrent = await isWatchlistImportPreviewCurrent(ctx.db, ctx.chatId, payload);
    const outcome = await applyWatchlistImportV2(ctx.db, {
      chatId: ctx.chatId,
      // A malformed or stale stored preview is consumed through the same
      // normalized webhook mutation, but the impossible generation prevents
      // every portable-preference statement from running.
      expectedPreferenceGeneration: previewCurrent ? payload.expectedPreferenceGeneration : -1,
      generationLease: payload.generationLease,
      directEntries: payload.directEntries,
      presetEntries: payload.presetEntries,
      directRemoveIds: payload.preview.directRemoves,
      presetRemoveIds: payload.preview.presetRemoves,
      pendingExpiresAt: expiresAt,
      pendingActionPayload: JSON.stringify(payload),
      operationStatements,
    });
    await recordTelegramUsageEvent(ctx.db, {
      eventType: "subscribe",
      actionDetail: "import-v2",
      outcome: outcome === "applied" ? "success" : "stale",
    });
    return outcome;
  }
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
    return "applied";
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
  return "applied";
}

async function applyConfirmation(ctx: CallbackContext, normalized: NormalizedConfirmation): Promise<void> {
  await ctx.planIntent?.(createTelegramWebhookIntent(`callback:${normalized.action}`, {
    action: normalized.action,
    kind: normalized.kind,
    expiresAt: normalized.expiresAt,
    payload: normalized.payload,
  }, "required"));
  let importOutcome: "applied" | "stale" = "applied";
  if (!ctx.wasMutationApplied) {
    const operationStatements = ctx.prepareMutationAppliedStatement
      ? [ctx.prepareMutationAppliedStatement()]
      : undefined;
    if (normalized.action === "cancel") {
      await clearPendingDisambiguation(ctx.db, ctx.chatId, {
        expected: {
          actionType: normalized.kind === "forget" ? "forget-confirm" : "confirm-bulk",
          expiresAt: normalized.expiresAt,
        },
        operationStatements,
      });
    } else if (normalized.kind === "forget") {
      await forgetSubscriber(ctx.db, ctx.chatId, { operationStatements });
    } else if (normalized.payload) {
      importOutcome = await executeConfirmedBulk(ctx, normalized.payload, normalized.expiresAt, operationStatements);
    }
    if (operationStatements) ctx.confirmAtomicMutationApplied?.();
    // The fallback exists for direct tests without an update_id claim; normal
    // webhook dispatch always commits a prepared marker with the domain write.
    else await ctx.markMutationApplied();
  } else if (
    normalized.action === "confirm"
    && normalized.payload?.kind === "watchlist-import-v2"
  ) {
    importOutcome = await watchlistPortableStateMatches(
      ctx.db,
      ctx.chatId,
      normalized.payload.directEntries,
      normalized.payload.presetEntries,
    ) ? "applied" : "stale";
  }

  const isWatchlistImport = normalized.payload?.kind === "watchlist-import-v2";
  const reply = normalized.action === "cancel"
    ? "Cancelled."
    : normalized.kind === "forget"
      ? "Your subscriber data has been deleted. Use /start to begin again."
      : isWatchlistImport && importOutcome === "stale"
        ? "Your alert settings changed after this preview, so the watchlist was not replaced. Re-run /import to review a fresh preview."
        : isWatchlistImport
          ? "Watchlist replaced exactly as previewed. Quiet hours, timezone, global-all settings, and snoozes on retained coin rows were left unchanged. Removed coin rows and their snoozes were deleted."
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
        : isWatchlistImport && importOutcome === "stale"
          ? "Preview stale. Nothing replaced."
          : "Applied.",
  });
}

export const handleBulkActionCallback: CallbackHandler = async (ctx) => {
  const { parsed } = ctx;
  if (
    (parsed.action !== "confirm" && parsed.action !== "cancel")
    || !hasExactParts(parsed.parts, 2)
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

  const normalized = parseStoredConfirmation(ctx)
    ?? await loadFreshConfirmation(ctx, parsed.action, parsed.arg);
  if (!normalized) return;
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
