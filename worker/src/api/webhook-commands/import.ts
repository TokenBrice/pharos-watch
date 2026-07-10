import { TELEGRAM_PRESET_IDS } from "@shared/lib/telegram-presets";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { escapeHtml } from "../../lib/telegram";
import { recordTelegramUsageEvent } from "../../lib/telegram-usage-analytics";
import { isSubscribableCoin } from "../../lib/telegram-subscription-eligibility";
import {
  decodeWatchlistToken,
  packWatchlistDirectState,
  packWatchlistPresetState,
  WATCHLIST_TOKEN_REGISTRY_VERSION,
} from "../../lib/telegram-watchlist-token";
import { TELEGRAM_PRESET_LABEL_BY_ID } from "../../lib/telegram-presets";
import {
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  buildWatchlistImportPreview,
  loadWatchlistPortableState,
  persistPendingConfirmBulk,
  prepareEnsureSubscriberExists,
} from "../telegram-webhook-store";
import { createTelegramWebhookIntent } from "../telegram-webhook-effect-fence";
import type { ConfirmBulkPayload } from "../telegram-webhook-shared";
import { DISAMBIGUATION_TTL_SEC } from "../telegram-webhook-shared";
import { parseStoredConfirmBulkPayload } from "../telegram-webhook-parsing";
import {
  BULK_CONFIRM_REPLY_MARKUP,
  buildBulkConfirmMessage,
  dedupePresetIds,
  subscribableCoinCount,
} from "./action-runner";
import type { WebhookCommandContext, WebhookCommandHandler } from "./context";

const VALID_IMPORT_ALERT_TYPES = new Set(["dews", "depeg", "safety", "launch", "reserve"]);
const KNOWN_PRESET_IDS = new Set<string>(TELEGRAM_PRESET_IDS);

function generateImportLease(): number {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return 4_000_000_000_000_000 + value;
}

function idsPreview(ids: readonly string[]): string {
  if (ids.length === 0) return "none";
  return ids.map((id) => {
    const symbol = TRACKED_META_BY_ID.get(id)?.symbol;
    return symbol ? `${symbol} [${id}]` : id;
  }).join(", ");
}

function presetPreview(ids: readonly string[]): string {
  if (ids.length === 0) return "none";
  return ids.map((id) => TELEGRAM_PRESET_LABEL_BY_ID.get(id as never) ?? id).join(", ");
}

function buildV1ConfirmMessage(
  coinCount: number,
  alertTypes: readonly string[],
  symbols: readonly string[],
  presetLabels: readonly string[],
): string {
  if (presetLabels.length === 0) return buildBulkConfirmMessage("subscribe", coinCount, alertTypes, symbols);
  const targetParts: string[] = [];
  if (coinCount > 0) targetParts.push(`${coinCount} ${coinCount === 1 ? "coin" : "coins"}`);
  targetParts.push(`${presetLabels.length} ${presetLabels.length === 1 ? "preset" : "presets"}`);
  const previewParts = [
    symbols.length > 0 ? symbols.join(", ") : "",
    `Presets: ${presetLabels.join(", ")}`,
  ].filter(Boolean);
  const types = alertTypes.length > 0 ? alertTypes.join(", ") : "all";
  return `This will subscribe ${targetParts.join(" and ")} for alert types ${escapeHtml(types)}. Confirm?\n${escapeHtml(previewParts.join("\n"))}`;
}

function buildV2PreviewMessage(payload: Extract<ConfirmBulkPayload, { kind: "watchlist-import-v2" }>): string {
  const preview = payload.preview;
  return [
    "<b>Replace portable watchlist state?</b>",
    "This replaces every direct/local coin row and followed preset in this chat with the token state. Global-all settings, quiet hours, timezone, and snoozes on retained coin rows stay unchanged. Removing a coin row also removes its per-coin snooze.",
    "",
    `<b>Direct/local rows</b>  Add ${preview.directAdds.length} · Remove ${preview.directRemoves.length} · Change ${preview.directChanges.length}`,
    `Add: ${escapeHtml(idsPreview(preview.directAdds))}`,
    `Remove: ${escapeHtml(idsPreview(preview.directRemoves))}`,
    `Change alert families/tuning: ${escapeHtml(idsPreview(preview.directChanges))}`,
    "",
    `<b>Presets</b>  Add ${preview.presetAdds.length} · Remove ${preview.presetRemoves.length} · Change ${preview.presetChanges.length}`,
    `Add: ${escapeHtml(presetPreview(preview.presetAdds))}`,
    `Remove: ${escapeHtml(presetPreview(preview.presetRemoves))}`,
    `Change alert families/tuning: ${escapeHtml(presetPreview(preview.presetChanges))}`,
    "",
    "Every changed id is listed above. Long previews are split deterministically; the confirmation keyboard is attached only to the final message.",
    "Confirm only if these exact replacement counts and ids are expected.",
  ].join("\n");
}

/** @internal Exact-preview regression seam. */
export const buildV2PreviewMessageForTest = buildV2PreviewMessage;

function storedImportPrompt(ctx: WebhookCommandContext): {
  payload: ConfirmBulkPayload;
  expiresAt: number;
} | null {
  const intent = ctx.storedIntent;
  if (intent?.kind !== "command:import" || intent.payload.stage !== "bulk-confirm-prompt") return null;
  const payloadValue = intent.payload.payload;
  if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) return null;
  const payload = parseStoredConfirmBulkPayload(payloadValue as Record<string, unknown>);
  const expiresAt = Number(intent.payload.expiresAt);
  return payload && Number.isSafeInteger(expiresAt) ? { payload, expiresAt } : null;
}

async function persistImportPreview(
  ctx: WebhookCommandContext,
  payload: ConfirmBulkPayload,
  expiresAt: number,
  ensureSubscriber: boolean,
): Promise<boolean> {
  await ctx.planIntent?.(createTelegramWebhookIntent("command:import", {
    stage: "bulk-confirm-prompt",
    payload,
    expiresAt,
  }, "required"));
  const actionPayload = JSON.stringify(payload);
  const operationStatements: D1PreparedStatement[] = [];
  const beforePendingStatements = ensureSubscriber
    ? [prepareEnsureSubscriberExists(ctx.db, ctx.chatId, ctx.username, ctx.operationNowSec)]
    : undefined;
  if (ctx.preparePendingMutationAppliedStatement) {
    operationStatements.push(ctx.preparePendingMutationAppliedStatement({
      chatId: ctx.chatId,
      actionType: "confirm-bulk",
      actionPayload,
      expiresAt,
    }));
  }
  const persisted = ctx.wasMutationApplied
    ? true
    : await persistPendingConfirmBulk(ctx.db, {
        chatId: ctx.chatId,
        payload,
        initiatorUserId: ctx.actorUserId,
        expiresAt,
        beforePendingStatements,
        operationStatements: operationStatements.length > 0 ? operationStatements : undefined,
      });
  if (!ctx.wasMutationApplied && persisted && operationStatements.length > 0) ctx.confirmAtomicMutationApplied?.();
  return persisted;
}

/** @internal Focused ownership/fence regression seam. */
export const persistImportPreviewForTest = persistImportPreview;

async function handleV1Import(
  ctx: WebhookCommandContext,
  state: { coinIds: string[]; alertTypes: string[]; presetIds: string[] },
  stored: { payload: ConfirmBulkPayload; expiresAt: number } | null,
): Promise<void> {
  let payload: Extract<ConfirmBulkPayload, { kind: "subscribe" }>;
  let droppedUnavailable = 0;
  if (stored?.payload.kind === "subscribe") {
    payload = stored.payload;
  } else {
    const seen = new Set<string>();
    const validIds: string[] = [];
    for (const id of state.coinIds) {
      if (!isSubscribableCoin(id)) {
        droppedUnavailable += 1;
        continue;
      }
      if (!seen.has(id)) {
        seen.add(id);
        validIds.push(id);
      }
    }
    const cappedIds = validIds.slice(0, subscribableCoinCount());
    const presetIds = dedupePresetIds(state.presetIds);
    if (cappedIds.length === 0 && presetIds.length === 0) {
      await ctx.replyToChat("No coins available for new alerts or known presets were found in that token.");
      await recordTelegramUsageEvent(ctx.db, { eventType: "subscribe", actionDetail: "import", outcome: "invalid" });
      return;
    }
    const filteredTypes = state.alertTypes.filter((type) => VALID_IMPORT_ALERT_TYPES.has(type));
    payload = {
      kind: "subscribe",
      alertTypes: filteredTypes.length > 0 ? filteredTypes : ["dews", "depeg"],
      presetIds,
      depegWorseningBpsStep: null,
      coinIds: cappedIds,
      subscribeAll: false,
    };
  }
  const expiresAt = stored?.expiresAt
    ?? (ctx.operationNowSec ?? Math.floor(Date.now() / 1000)) + DISAMBIGUATION_TTL_SEC;
  if (!(await persistImportPreview(ctx, payload, expiresAt, false))) {
    await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
    return;
  }
  const symbols = payload.coinIds.map((id) => TRACKED_META_BY_ID.get(id)?.symbol ?? id);
  const presetLabels = payload.presetIds.map((id) => TELEGRAM_PRESET_LABEL_BY_ID.get(id as never) ?? id);
  const droppedNote = droppedUnavailable > 0
    ? `\n(${droppedUnavailable} ${droppedUnavailable === 1 ? "coin is" : "coins are"} not available for new alerts and ${droppedUnavailable === 1 ? "was" : "were"} skipped.)`
    : "";
  await ctx.replyToChatWithMarkup(
    [
      "<b>Legacy v1 token: additive import</b>",
      "This only adds/enables the listed coverage. It does not remove existing rows. Per-coin tuning was not stored by v1.",
      buildV1ConfirmMessage(payload.coinIds.length, payload.alertTypes, symbols, presetLabels),
    ].join("\n") + droppedNote,
    { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
  );
  await recordTelegramUsageEvent(ctx.db, { eventType: "subscribe", actionDetail: "import-v1", outcome: "preview" });
}

export const handleImport: WebhookCommandHandler = async (ctx, args) => {
  const stored = storedImportPrompt(ctx);
  const decoded = stored ? null : await decodeWatchlistToken(args ?? "");
  if (decoded && !decoded.ok) {
    const message = decoded.error === "empty"
      ? "Usage: /import <token> — paste a token from /export in another chat."
      : decoded.error === "too-large"
        ? "That token is too large to import safely."
        : decoded.error === "integrity"
          ? "That token failed its integrity check. Copy the full token from /export and try again."
          : decoded.error === "unsupported-version"
            ? "That token is from an unsupported version. Re-run /export with the current bot."
            : "That token is malformed and could not be read. Copy the full token from /export and try again.";
    await ctx.replyToChat(message);
    await recordTelegramUsageEvent(ctx.db, { eventType: "subscribe", actionDetail: "import", outcome: "invalid" });
    return;
  }

  if (stored?.payload.kind === "subscribe" || decoded?.version === 1) {
    const state = decoded?.version === 1 ? decoded.state : { coinIds: [], alertTypes: [], presetIds: [] };
    await handleV1Import(ctx, state, stored);
    return;
  }

  let payload: Extract<ConfirmBulkPayload, { kind: "watchlist-import-v2" }>;
  let ensureSubscriber = false;
  const expiresAt = stored?.expiresAt
    ?? (ctx.operationNowSec ?? Math.floor(Date.now() / 1000)) + DISAMBIGUATION_TTL_SEC;
  if (stored?.payload.kind === "watchlist-import-v2") {
    payload = stored.payload;
  } else if (decoded?.version === 2) {
    const unavailable = decoded.state.direct.filter((row) => !isSubscribableCoin(row.stablecoinId));
    const unknownPresets = decoded.state.presets.filter((row) => !KNOWN_PRESET_IDS.has(row.presetId));
    if (unavailable.length > 0 || unknownPresets.length > 0) {
      await ctx.replyToChat(
        `This v2 token contains ${unavailable.length} unavailable coin row${unavailable.length === 1 ? "" : "s"} and ${unknownPresets.length} unknown preset${unknownPresets.length === 1 ? "" : "s"}. Nothing was imported; ask the source chat to remove retired entries and export again.`,
      );
      await recordTelegramUsageEvent(ctx.db, { eventType: "subscribe", actionDetail: "import-v2", outcome: "invalid" });
      return;
    }
    const current = await loadWatchlistPortableState(ctx.db, ctx.chatId, WATCHLIST_TOKEN_REGISTRY_VERSION);
    const preview = buildWatchlistImportPreview(current.state, decoded.state);
    const totalChanges = Object.values(preview).reduce((sum, ids) => sum + ids.length, 0);
    if (totalChanges === 0) {
      await ctx.replyToChat("This chat's portable watchlist state already matches that token. Nothing changed.");
      return;
    }
    ensureSubscriber = current.preferenceGeneration == null;
    payload = {
      kind: "watchlist-import-v2",
      registryVersion: decoded.state.registryVersion,
      directEntries: decoded.state.direct.map(packWatchlistDirectState).sort(),
      presetEntries: decoded.state.presets.map(packWatchlistPresetState).sort(),
      expectedPreferenceGeneration: current.preferenceGeneration ?? 0,
      generationLease: generateImportLease(),
      preview,
    };
  } else {
    await ctx.replyToChat("That stored import preview is no longer valid. Re-run /import with the token.");
    return;
  }

  if (!(await persistImportPreview(ctx, payload, expiresAt, ensureSubscriber))) {
    await ctx.replyToChat(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
    return;
  }
  await ctx.replyToChatWithMarkup(buildV2PreviewMessage(payload), { replyMarkup: BULK_CONFIRM_REPLY_MARKUP });
  await recordTelegramUsageEvent(ctx.db, { eventType: "subscribe", actionDetail: "import-v2", outcome: "preview" });
};
