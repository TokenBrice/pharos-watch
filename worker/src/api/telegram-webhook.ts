import { timingSafeCompare } from "../lib/auth";
import { escapeHtml, sendToChat } from "../lib/telegram";
import {
  formatAdministratorMentions,
  getCachedChatAdministrators,
  getCachedChatMember,
} from "../lib/telegram-chat-member";
import {
  formatDisambiguation,
  parseTargetArgs,
  resolveTicker,
  parseSubscribeArgs,
  splitMessage,
  validateSubscribeArgs,
  parseDisambiguationReply,
  type ResolvedCoin,
  type TickerResolutionScope,
} from "../lib/telegram-alerts";
import {
  listTelegramPresets,
  resolveTelegramPresetTargets,
  type TelegramPresetId,
} from "../lib/telegram-presets";
import { TRACKED_STABLECOINS, FROZEN_IDS } from "@shared/lib/stablecoins";
import {
  HELP_MESSAGE,
  SETUP_PENDING_ACTION_TYPE,
  START_MESSAGE,
  type ConfirmBulkPayload,
  type ParsedSetCommand,
  type PendingAction,
  type PendingDisambiguationRow,
  type SubscribeActionPayload,
  type SubscriptionRow,
  type TelegramWebhookUpdate,
  type UnsubscribeActionPayload,
} from "./telegram-webhook-shared";
import { handleSetupTickerInput, parseSetupState, sendWizardIntro } from "./telegram-webhook-setup";
import {
  buildGlobalAlertSummaryMessage,
  buildListMessage,
  buildNotFoundMessage,
  buildPresetCatalogMessage,
  buildPresetSubscriptionSummaryMessage,
  buildPresetUnavailableMessage,
  buildPresetUnsubscribeSummaryMessage,
  buildStatusAmbiguousMessage,
  buildStatusMessage,
  buildSubscriptionSummaryMessage,
  buildUnsubscribeSuccessMessage,
  formatQuietHours,
} from "./telegram-webhook-messages";
import { loadStatusForCoin } from "./telegram-webhook-status";
import {
  dedupeCoins,
  parseCommand,
  parsePendingDisambiguation,
  parseQuietHours,
  parseSetCommand,
  parseStartPayload,
} from "./telegram-webhook-parsing";
import {
  applyGlobalSetting,
  applySettingToSubscriptions,
  clearAlertSnooze,
  clearPendingDisambiguation,
  loadPresetSubscriptions,
  loadSubscriberByChat,
  loadSubscriptionsByIds,
  persistPendingConfirmBulk,
  removePresetSubscriptions,
  removeSubscriptions,
  unixNow,
  upsertPresetSubscriptions,
  upsertSubscriberAndSubscriptions,
  upsertSubscriberRow,
  validateGlobalSetCommand,
} from "./telegram-webhook-store";
import { withErrorHandler } from "../lib/api-utils";
import { handleCallbackQuery } from "./telegram-webhook-callbacks";
import { runCoinResolutionFlow } from "./telegram-webhook-resolution";
import {
  buildBriefMessage,
  buildCoverageMessage,
  buildTopMessage,
  buildWhyMessage,
} from "./telegram-webhook-insights";

/**
 * Group admin gating mode for `/subscribe`, `/unsubscribe`, `/set` in
 * group/supergroup chats. "hard" refuses the command for non-admins (default).
 * "soft" is kept as an emergency rollback path for operators: it warns the
 * non-admin and still runs the command. The exported wrapper is mutable so
 * tests can flip the mode; production code should keep the default.
 */
export type TelegramGroupAdminGating = "soft" | "hard";
/** @internal Exported for tests only — do not mutate in production code. */
export const TELEGRAM_GROUP_ADMIN_GATING: { mode: TelegramGroupAdminGating } = {
  mode: "hard",
};

const GROUP_ADMIN_GATED_COMMANDS = new Set(["/subscribe", "/unsubscribe", "/set"]);

export const handleTelegramWebhook = withErrorHandler(
  "telegram-webhook",
  async (
    db: D1Database,
    request: Request,
    webhookSecret?: string,
    botToken?: string,
    previousWebhookSecret?: string,
  ): Promise<Response> => {
  const ok = () => new Response("ok", { status: 200 });

    const providedSecret =
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
    if (!providedSecret.trim()) {
      return ok();
    }
    const validCurrentSecret = webhookSecret
      ? await timingSafeCompare(providedSecret, webhookSecret)
      : false;
    const validPreviousSecret = previousWebhookSecret
      ? await timingSafeCompare(providedSecret, previousWebhookSecret)
      : false;
    if (!validCurrentSecret && !validPreviousSecret) {
      console.warn("[telegram-webhook] auth validation failed — returning 200 to prevent retry storm");
      return ok();
    }
    if (!botToken) return ok();

    let update: TelegramWebhookUpdate;
    try {
      update = await request.json();
    } catch {
      return ok();
    }

    const updateId = update.update_id;
    if (typeof updateId === "number") {
      const dedup = await db
        .prepare(
          `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE CAST(cache.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
        )
        .bind("telegram:last-update-id", String(updateId), Math.floor(Date.now() / 1000))
        .run();
      if (dedup.meta.changes === 0) {
        return ok();
      }
    }

    if (update.callback_query) {
      try {
        await handleCallbackQuery(db, botToken, update.callback_query);
      } catch (err) {
        console.error("[telegram-webhook] callback_query failed:", err);
      }
      return ok();
    }

    const chatId = update.message?.chat?.id?.toString();
    const text = update.message?.text?.trim();
    const username = update.message?.chat?.username ?? null;
    const actorUserId = update.message?.from?.id != null ? String(update.message.from.id) : null;
    const chatType = update.message?.chat?.type ?? "private";
    if (!chatId || !text) return ok();

    const reply = async (message: string) => {
      await replyToChat(chatId, message, botToken);
    };

    try {
      const parsedCommand = text.startsWith("/") ? parseCommand(text) : null;
      if (parsedCommand && isGroupChat(chatType) && !isAddressedToPharosBot(parsedCommand.botMention)) {
        return ok();
      }

      const pendingRow = await db
        .prepare(
          "SELECT action_type, action_payload, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at, initiator_user_id FROM telegram_pending_disambiguation WHERE chat_id = ?",
        )
        .bind(chatId)
        .first<PendingDisambiguationRow>();

      const pendingNotExpired = Boolean(pendingRow && unixNow() < pendingRow.expires_at);
      const isSetupPending =
        Boolean(pendingRow && pendingNotExpired && pendingRow.action_type === SETUP_PENDING_ACTION_TYPE);

      if (isSetupPending && pendingRow) {
        const setupState = parseSetupState(pendingRow.action_payload, pendingRow.initiator_user_id ?? null);
        if (setupState && setupState.step === "awaiting-ticker" && !parsedCommand) {
          await handleSetupTickerInput(
            { db, botToken, chatId, actorUserId, username },
            text,
            setupState,
          );
          return ok();
        }
        // A new slash command in setup state clears the wizard before running the command.
        if (parsedCommand) {
          await clearPendingDisambiguation(db, chatId);
        }
      }

      const pendingAction = !isSetupPending && pendingRow ? parsePendingDisambiguation(pendingRow) : null;
      const pendingActive = Boolean(!isSetupPending && pendingRow && pendingAction && pendingNotExpired);

      if (!isSetupPending && pendingRow && !pendingAction && pendingNotExpired) {
        await clearPendingDisambiguation(db, chatId);
        if (!parsedCommand) {
          await reply("That pending selection could not be restored. Please rerun the command, or use /help for examples.");
          return ok();
        }
      }

      if (!isSetupPending && pendingRow && !pendingActive) {
        await clearPendingDisambiguation(db, chatId);
      }

      if (pendingActive && pendingAction) {
        if (!parsedCommand) {
          if (pendingAction.actionType === "confirm-bulk") {
            // Bulk-confirm pending waits for an inline button tap, not a text reply.
            // Ignore plain text in groups; in private chats, nudge toward the buttons.
            if (isGroupChat(chatType)) return ok();
            await reply("Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
            return ok();
          }
          if (!canActOnPending(pendingAction, actorUserId)) {
            if (isGroupChat(chatType) && !looksLikeDisambiguationSelection(text)) {
              return ok();
            }
            await reply("Only the user who started this pending selection can complete it.");
            return ok();
          }
          await handleDisambiguationReply(db, chatId, text, pendingAction, botToken, username);
          return ok();
        }

        switch (parsedCommand.command) {
          case "/cancel":
            if (!canActOnPending(pendingAction, actorUserId)) {
              await reply("Only the user who started this pending selection can cancel it.");
              return ok();
            }
            await clearPendingDisambiguation(db, chatId);
            await reply("Pending selection cancelled.");
            return ok();
          case "/presets":
            await reply(buildPresetCatalogMessage(listTelegramPresets()));
            return ok();
          case "/help":
            await reply(HELP_MESSAGE);
            return ok();
          case "/list":
            await handleList(db, chatId, botToken);
            return ok();
          case "/status":
            await handleStatus(db, chatId, parsedCommand.args, botToken);
            return ok();
          case "/brief":
          case "/market":
            await handleBrief(db, chatId, botToken);
            return ok();
          case "/top":
            await handleTop(db, chatId, parsedCommand.args, botToken);
            return ok();
          case "/why":
            await handleWhy(db, chatId, parsedCommand.args, botToken);
            return ok();
          case "/coverage":
            await handleCoverage(db, chatId, parsedCommand.args, botToken);
            return ok();
          case "/start":
            await handleStart(db, chatId, actorUserId, parsedCommand.args, botToken);
            return ok();
          case "/subscribe":
          case "/unsubscribe":
          case "/set":
          case "/mute":
          case "/unmutehours":
          case "/unsnooze":
            if (!canActOnPending(pendingAction, actorUserId)) {
              await reply("Another user has a pending ticker selection in this chat. Ask them to finish or /cancel it first.");
              return ok();
            }
            await clearPendingDisambiguation(db, chatId);
            break;
          default:
            if (pendingAction.actionType === "confirm-bulk") {
              await reply("You have a pending bulk confirmation. Tap Confirm or Cancel on the previous message, or send /cancel to abort.");
              return ok();
            }
            await reply(`You have a pending selection. Reply with the number(s) you want, or use /cancel.

${escapeHtml(formatDisambiguation(pendingAction.ambiguousTicker, pendingAction.candidates))}`);
            return ok();
        }
      }

      if (!parsedCommand) return ok();

      if (
        isGroupChat(chatType) &&
        GROUP_ADMIN_GATED_COMMANDS.has(parsedCommand.command) &&
        actorUserId != null
      ) {
        const proceed = await maybeGateNonAdminGroupActor(
          db,
          botToken,
          chatId,
          actorUserId,
          parsedCommand.command,
          reply,
        );
        if (!proceed) return ok();
      }

      switch (parsedCommand.command) {
        case "/start":
          await handleStart(
            db,
            chatId,
            chatType,
            username,
            actorUserId,
            parsedCommand.args,
            botToken,
          );
          break;
        case "/presets":
          await reply(buildPresetCatalogMessage(listTelegramPresets()));
          break;
        case "/help":
          await reply(HELP_MESSAGE);
          break;
        case "/list":
          await handleList(db, chatId, botToken);
          break;
        case "/status":
          await handleStatus(db, chatId, parsedCommand.args, botToken);
          break;
        case "/brief":
        case "/market":
          await handleBrief(db, chatId, botToken);
          break;
        case "/top":
          await handleTop(db, chatId, parsedCommand.args, botToken);
          break;
        case "/why":
          await handleWhy(db, chatId, parsedCommand.args, botToken);
          break;
        case "/coverage":
          await handleCoverage(db, chatId, parsedCommand.args, botToken);
          break;
        case "/subscribe":
          await handleSubscribe(db, chatId, username, actorUserId, parsedCommand.args, botToken);
          break;
        case "/unsubscribe":
          await handleUnsubscribe(db, chatId, actorUserId, parsedCommand.args, botToken);
          break;
        case "/set":
          await handleSet(db, chatId, username, actorUserId, parsedCommand.args, botToken);
          break;
        case "/mute":
          await handleMute(db, chatId, username, parsedCommand.args, botToken);
          break;
        case "/unmutehours":
          await handleUnmuteHours(db, chatId, username, botToken);
          break;
        case "/unsnooze":
          await handleUnsnooze(db, chatId, username, botToken);
          break;
        case "/cancel":
          await reply("No pending selection to cancel.");
          break;
        default:
          await reply("Unknown command. Try /help");
      }
    } catch (err) {
      console.error("[telegram-webhook] Error:", err);
      await reply("Something went wrong, please try again.");
    }

    return ok();
  },
);

async function handleStart(
  db: D1Database,
  chatId: string,
  chatType: string,
  username: string | null,
  actorUserId: string | null,
  args: string,
  botToken: string,
): Promise<void> {
  const payload = parseStartPayload(args);
  switch (payload.kind) {
    case "subscribe":
      if (chatType !== "private") {
        await replyToChat(chatId, START_MESSAGE, botToken);
        return;
      }
      await handleSubscribe(db, chatId, username, actorUserId, payload.args, botToken);
      return;
    case "status":
      await handleStatus(db, chatId, payload.coinId, botToken);
      return;
    case "why":
      await handleWhy(db, chatId, payload.coinId, botToken);
      return;
    case "coverage":
      await handleCoverage(db, chatId, payload.coinId, botToken);
      return;
    case "setup":
    case "none":
      // Empty payload or `?start=setup` both open the wizard.
      await sendWizardIntro(db, botToken, chatId, actorUserId);
      return;
  }
}

async function handleList(db: D1Database, chatId: string, botToken: string): Promise<void> {
  const subscriber = await loadSubscriberByChat(db, chatId);

  const [subscriptions, presetSubscriptions] = await Promise.all([
    db
      .prepare(
        `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, alert_launch, dews_min_band, safety_mode, depeg_worsening_bps_step
           FROM telegram_subscriptions
          WHERE chat_id = ?
          ORDER BY stablecoin_id`,
      )
      .bind(chatId)
      .all<SubscriptionRow>(),
    loadPresetSubscriptions(db, chatId),
  ]);

  const rows = subscriptions.results ?? [];
  if (!subscriber && rows.length === 0 && presetSubscriptions.length === 0) {
    await replyToChat(chatId, "No active subscriptions. Use /subscribe to get started, or try /presets for preset watchlists.", botToken);
    return;
  }

  const message = buildListMessage(subscriber, rows, presetSubscriptions);
  await replyToChat(chatId, message, botToken);
}

async function handleStatus(
  db: D1Database,
  chatId: string,
  args: string,
  botToken: string,
): Promise<void> {
  const trimmed = args.trim();
  if (!trimmed) {
    await replyToChat(chatId, "Usage: /status &lt;ticker&gt;", botToken);
    return;
  }
  const resolution = resolveTicker(trimmed, "tracked");
  if (resolution.status === "not_found") {
    await replyToChat(chatId, buildNotFoundMessage(trimmed, resolution.suggestion), botToken);
    return;
  }
  if (resolution.status === "ambiguous") {
    await replyToChat(chatId, buildStatusAmbiguousMessage(trimmed, resolution.matches), botToken);
    return;
  }
  const coin = resolution.matches[0];
  const status = await loadStatusForCoin(db, coin.id);
  await replyToChat(chatId, buildStatusMessage(coin.symbol, status), botToken);
}

async function handleBrief(db: D1Database, chatId: string, botToken: string): Promise<void> {
  await replyToChat(chatId, await buildBriefMessage(db), botToken);
}

async function handleTop(
  db: D1Database,
  chatId: string,
  args: string,
  botToken: string,
): Promise<void> {
  const view = args.trim();
  if (!view) {
    await replyToChat(chatId, "Usage: /top depeg|dews|yield|liquidity|chains|safety", botToken);
    return;
  }
  await replyToChat(chatId, await buildTopMessage(db, view), botToken);
}

async function resolveSingleStatusTarget(
  chatId: string,
  args: string,
  botToken: string,
  commandName = "/why",
): Promise<ResolvedCoin | null> {
  const trimmed = args.trim();
  if (!trimmed) {
    await replyToChat(chatId, `Usage: ${commandName} &lt;ticker&gt;`, botToken);
    return null;
  }
  const resolution = resolveTicker(trimmed, "tracked");
  if (resolution.status === "not_found") {
    await replyToChat(chatId, buildNotFoundMessage(trimmed, resolution.suggestion), botToken);
    return null;
  }
  if (resolution.status === "ambiguous") {
    await replyToChat(chatId, buildStatusAmbiguousMessage(trimmed, resolution.matches), botToken);
    return null;
  }
  return resolution.matches[0] ?? null;
}

async function handleWhy(
  db: D1Database,
  chatId: string,
  args: string,
  botToken: string,
): Promise<void> {
  const coin = await resolveSingleStatusTarget(chatId, args, botToken, "/why");
  if (!coin) return;
  await replyToChat(chatId, await buildWhyMessage(db, coin.id), botToken);
}

async function handleCoverage(
  db: D1Database,
  chatId: string,
  args: string,
  botToken: string,
): Promise<void> {
  const coin = await resolveSingleStatusTarget(chatId, args, botToken, "/coverage");
  if (!coin) return;
  const status = await loadStatusForCoin(db, coin.id);
  await replyToChat(chatId, buildCoverageMessage(coin.symbol, status), botToken);
}

interface TelegramActionContext {
  db: D1Database;
  chatId: string;
  username: string | null;
  initiatorUserId: string | null;
}

type ActionPayloadMap = {
  subscribe: SubscribeActionPayload;
  unsubscribe: UnsubscribeActionPayload;
  set: ParsedSetCommand;
};

const TELEGRAM_PRESET_LABEL_BY_ID = new Map(
  listTelegramPresets().map((definition) => [definition.id, definition.label] as const),
);

const PHAROS_BOT_USERNAMES = new Set(["pharoswatchbot"]);

/**
 * Bulk subscribe/unsubscribe commands are gated behind an inline Confirm/Cancel
 * keyboard when the resolved coin set exceeds this threshold OR the literal
 * `all` token was used. See P0-C1 in `agents/pharoswatchbot-reliability-and-ux-plan-2026-05-11.md`.
 */
const BULK_CONFIRM_COIN_THRESHOLD = 10;
const BULK_CONFIRM_PREVIEW_LIMIT = 5;

const SUBSCRIBABLE_COIN_COUNT = TRACKED_STABLECOINS.filter((coin) => !FROZEN_IDS.has(coin.id)).length;

function subscribableCoinCount(): number {
  return SUBSCRIBABLE_COIN_COUNT;
}

const BULK_CONFIRM_REPLY_MARKUP = {
  inline_keyboard: [[
    { text: "Confirm", callback_data: "confirm:bulk" },
    { text: "Cancel", callback_data: "cancel:bulk" },
  ]],
} as const;

function formatBulkAlertTypeList(alertTypes: readonly string[]): string {
  if (alertTypes.length === 0) return "all";
  return alertTypes.join(", ");
}

function formatBulkCoinPreview(symbols: readonly string[]): string {
  if (symbols.length === 0) return "";
  const head = symbols.slice(0, BULK_CONFIRM_PREVIEW_LIMIT);
  const more = symbols.length - head.length;
  const suffix = more > 0 ? `, ...and ${more} more` : "";
  return `${head.join(", ")}${suffix}`;
}

function buildBulkConfirmMessage(
  action: "subscribe" | "unsubscribe",
  count: number,
  alertTypes: readonly string[],
  coinSymbols: readonly string[],
): string {
  const verb = action === "subscribe" ? "subscribe" : "unsubscribe";
  const typesLine =
    action === "subscribe"
      ? `alert types ${escapeHtml(formatBulkAlertTypeList(alertTypes))}`
      : "all alert types";
  const preview = formatBulkCoinPreview(coinSymbols);
  const previewLine = preview ? `\n${escapeHtml(preview)}` : "";
  return `This will ${verb} ${count} coins for ${typesLine}. Confirm?${previewLine}`;
}

function isGroupChat(chatType: string): boolean {
  return chatType === "group" || chatType === "supergroup";
}

/**
 * Returns `true` when the command should proceed, `false` when it has been
 * refused (hard gate) and the caller must stop processing the update.
 */
async function maybeGateNonAdminGroupActor(
  db: D1Database,
  botToken: string,
  chatId: string,
  actorUserId: string,
  command: string,
  reply: (message: string) => Promise<void>,
): Promise<boolean> {
  const member = await getCachedChatMember(db, botToken, chatId, actorUserId);
  if (member && (member.status === "creator" || member.status === "administrator")) {
    return true;
  }

  const admins = await getCachedChatAdministrators(db, botToken, chatId);
  const mentions = admins ? formatAdministratorMentions(admins) : "";
  const adminLine = mentions ? ` Admins here: ${mentions}.` : "";
  await reply(
    escapeHtml(
      `Only group admins can change subscriptions (${command}).${adminLine}`,
    ),
  );
  return TELEGRAM_GROUP_ADMIN_GATING.mode !== "hard";
}

function isAddressedToPharosBot(botMention: string | null): boolean {
  return botMention != null && PHAROS_BOT_USERNAMES.has(botMention);
}

function canActOnPending(pending: PendingAction, actorUserId: string | null): boolean {
  return pending.initiatorUserId == null || pending.initiatorUserId === actorUserId;
}

function looksLikeDisambiguationSelection(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  let hasDigit = false;
  let pendingSeparator = false;
  for (const char of trimmed) {
    if (char >= "0" && char <= "9") {
      hasDigit = true;
      pendingSeparator = false;
      continue;
    }
    if (char === "," || char.trim() === "") {
      if (!hasDigit) return false;
      pendingSeparator = true;
      continue;
    }
    return false;
  }

  return hasDigit && !pendingSeparator;
}

function dedupePresetIds(presetIds: readonly string[]): TelegramPresetId[] {
  return Array.from(
    new Set(
      presetIds.filter((presetId): presetId is TelegramPresetId =>
        TELEGRAM_PRESET_LABEL_BY_ID.has(presetId as TelegramPresetId),
      ),
    ),
  );
}

type CompletionActionType = keyof ActionPayloadMap;

type CompletionHandlerMap = {
  [K in CompletionActionType]: (
    context: TelegramActionContext,
    coins: ResolvedCoin[],
    payload: ActionPayloadMap[K],
    options: { clearPending: boolean },
  ) => Promise<string>;
};

const completionHandlers: CompletionHandlerMap = {
  subscribe: async (context, coins, payload, options) => {
    const alertTypes = new Set(payload.alertTypes);
    const presetIds = dedupePresetIds(payload.presetIds ?? []);
    await upsertSubscriberAndSubscriptions(
      context.db,
      context.chatId,
      context.username,
      alertTypes,
      coins.map((coin) => coin.id),
      {
        clearPending: options.clearPending,
        depegWorseningBpsStep: payload.depegWorseningBpsStep,
      },
    );
    if (presetIds.length > 0) {
      await upsertPresetSubscriptions(context.db, context.chatId, presetIds, alertTypes, {
        depegWorseningBpsStep: payload.depegWorseningBpsStep,
      });
    }
    const subscriptions = await loadSubscriptionsByIds(
      context.db,
      context.chatId,
      coins.map((coin) => coin.id),
    );
    if (presetIds.length > 0) {
      return buildPresetSubscriptionSummaryMessage(subscriptions, {
        presetIds,
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
      });
    }
    return buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions);
  },
  unsubscribe: async (context, coins, payload, options) => {
    const presetIds = dedupePresetIds(payload.presetIds ?? []);
    if (options.clearPending) {
      await clearPendingDisambiguation(context.db, context.chatId);
    }
    await removeSubscriptions(
      context.db,
      context.chatId,
      coins.map((coin) => coin.id),
    );
    if (presetIds.length > 0) {
      await removePresetSubscriptions(context.db, context.chatId, presetIds);
    }
    if (presetIds.length > 0) {
      return buildPresetUnsubscribeSummaryMessage(coins, {
        presetIds,
        presetLabelById: TELEGRAM_PRESET_LABEL_BY_ID,
      });
    }
    return buildUnsubscribeSuccessMessage(coins);
  },
  set: async (context, coins, payload, options) => {
    if (options.clearPending) {
      await clearPendingDisambiguation(context.db, context.chatId);
    }
    await applySettingToSubscriptions(context.db, context.chatId, context.username, coins, payload);
    const subscriptions = await loadSubscriptionsByIds(
      context.db,
      context.chatId,
      coins.map((coin) => coin.id),
    );
    return buildSubscriptionSummaryMessage("Updated settings.", subscriptions);
  },
};

type BoundActionRunner = <TActionType extends "subscribe" | "unsubscribe" | "set">(opts: {
  tickers: string[];
  actionType: TActionType;
  actionPayload: ActionPayloadMap[TActionType];
  alertTypes?: Set<string>;
  initialCoins?: ResolvedCoin[];
  clearPendingOnTerminal?: boolean;
  resolutionScope?: TickerResolutionScope;
}) => Promise<void>;

/**
 * Optional gate that, when satisfied, defers subscribe/unsubscribe execution
 * behind an inline Confirm/Cancel keyboard. The gate fires once coin resolution
 * is complete; `kind` is fixed at handler construction so the deferred payload
 * matches the originating command.
 */
type BulkGate =
  | {
      kind: "subscribe";
      alertTypes: string[];
      presetIds: string[];
      depegWorseningBpsStep?: 100 | 250 | 500 | null;
    }
  | {
      kind: "unsubscribe";
      presetIds: string[];
    };

function shouldGateBulk(coinCount: number): boolean {
  return coinCount > BULK_CONFIRM_COIN_THRESHOLD;
}

async function persistAndPromptBulkConfirm(
  context: TelegramActionContext,
  botToken: string,
  gate: BulkGate,
  coins: ResolvedCoin[],
  clearPending: boolean,
): Promise<string> {
  if (clearPending) {
    await clearPendingDisambiguation(context.db, context.chatId);
  }
  const coinIds = coins.map((coin) => coin.id);
  const symbols = coins.map((coin) => coin.symbol);
  const payload: ConfirmBulkPayload =
    gate.kind === "subscribe"
      ? {
          kind: "subscribe",
          alertTypes: gate.alertTypes,
          presetIds: gate.presetIds,
          depegWorseningBpsStep: gate.depegWorseningBpsStep,
          coinIds,
          subscribeAll: false,
        }
      : {
          kind: "unsubscribe",
          presetIds: gate.presetIds,
          coinIds,
          unsubscribeAll: false,
        };
  await persistPendingConfirmBulk(context.db, {
    chatId: context.chatId,
    payload,
    initiatorUserId: context.initiatorUserId,
  });
  await replyToChat(
    context.chatId,
    buildBulkConfirmMessage(
      gate.kind,
      coinIds.length,
      gate.kind === "subscribe" ? gate.alertTypes : [],
      symbols,
    ),
    botToken,
    { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
  );
  // Sentinel: runCoinResolutionFlow will send this string. We have already
  // replied with the inline keyboard, so return an empty string and short-circuit
  // the outer reply via the GATED_SENTINEL check below.
  return GATED_SENTINEL;
}

const GATED_SENTINEL = " __gated__";

function makeActionRunner(
  context: TelegramActionContext,
  botToken: string,
  gate?: BulkGate,
): BoundActionRunner {
  const reply = async (message: string) => {
    if (message === GATED_SENTINEL) return;
    await replyToChat(context.chatId, message, botToken);
  };
  return ({ tickers, actionType, actionPayload, alertTypes, initialCoins, clearPendingOnTerminal, resolutionScope }) =>
    runCoinResolutionFlow({
      db: context.db,
      chatId: context.chatId,
      tickers,
      initialCoins,
      actionType,
      actionPayload,
      initiatorUserId: context.initiatorUserId,
      alertTypes,
      clearPendingOnTerminal,
      resolutionScope,
      reply,
      onComplete: async (coins, options) => {
        if (gate && shouldGateBulk(coins.length) && (gate.kind === actionType)) {
          return persistAndPromptBulkConfirm(context, botToken, gate, coins, options.clearPending);
        }
        return completionHandlers[actionType](context, coins, actionPayload, options);
      },
    });
}

async function resolvePresetCoins(
  db: D1Database,
  presetIds: readonly TelegramPresetId[],
): Promise<ResolvedCoin[] | null> {
  if (presetIds.length === 0) return [];

  const resolvedPresets = await resolveTelegramPresetTargets(db, presetIds);
  if (resolvedPresets.kind !== "ok") {
    return null;
  }
  return dedupeCoins(resolvedPresets.presets.flatMap((preset) => preset.coins));
}

async function handleSubscribe(
  db: D1Database,
  chatId: string,
  username: string | null,
  actorUserId: string | null,
  args: string,
  botToken: string,
): Promise<void> {
  const parsed = parseSubscribeArgs(args);
  const validationError = validateSubscribeArgs(parsed);
  if (validationError) {
    if (parsed.invalidTargets.length > 0 && parsed.alertTypes.size > 0) {
      const invalidTarget = parsed.invalidTargets[0];
      const match = resolveTicker(invalidTarget);
      const suggestion = match.status === "not_found" ? match.suggestion : undefined;
      await replyToChat(chatId, buildNotFoundMessage(invalidTarget, suggestion), botToken);
      return;
    }
    await replyToChat(chatId, escapeHtml(validationError), botToken);
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
    await replyToChat(
      chatId,
      buildBulkConfirmMessage("subscribe", subscribableCoinCount(), [...parsed.alertTypes], []),
      botToken,
      { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
    );
    return;
  }

  const presetIds = dedupePresetIds(parsed.presetIds);
  const presetCoins = await resolvePresetCoins(db, presetIds);
  if (presetCoins == null) {
    await replyToChat(chatId, buildPresetUnavailableMessage(), botToken);
    return;
  }

  const runAction = makeActionRunner(
    { db, chatId, username, initiatorUserId: actorUserId },
    botToken,
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
}

async function handleUnsubscribe(
  db: D1Database,
  chatId: string,
  actorUserId: string | null,
  args: string,
  botToken: string,
): Promise<void> {
  const parsed = parseTargetArgs(args, { resolutionScope: "tracked" });
  if (args.trim().length === 0) {
    await replyToChat(chatId, "Specify ticker(s) or preset(s) to unsubscribe, or use /unsubscribe all", botToken);
    return;
  }

  if (parsed.includeAll && (parsed.tickers.length > 0 || parsed.presetIds.length > 0)) {
    await replyToChat(chatId, 'Use /unsubscribe all by itself, or specify ticker/preset targets without "all".', botToken);
    return;
  }

  if (parsed.invalidTargets.length > 0) {
    const invalidTarget = parsed.invalidTargets[0];
    const match = resolveTicker(invalidTarget, "tracked");
    const suggestion = match.status === "not_found" ? match.suggestion : undefined;
    await replyToChat(chatId, buildNotFoundMessage(invalidTarget, suggestion), botToken);
    return;
  }

  if (parsed.includeAll) {
    await persistPendingConfirmBulk(db, {
      chatId,
      payload: {
        kind: "unsubscribe",
        presetIds: [],
        coinIds: [],
        unsubscribeAll: true,
      },
      initiatorUserId: actorUserId,
    });
    await replyToChat(
      chatId,
      buildBulkConfirmMessage("unsubscribe", subscribableCoinCount(), [], []),
      botToken,
      { replyMarkup: BULK_CONFIRM_REPLY_MARKUP },
    );
    return;
  }

  const presetIds = dedupePresetIds(parsed.presetIds);
  const presetCoins = await resolvePresetCoins(db, presetIds);
  if (presetCoins == null) {
    await replyToChat(chatId, buildPresetUnavailableMessage(), botToken);
    return;
  }

  const runAction = makeActionRunner(
    { db, chatId, username: null, initiatorUserId: actorUserId },
    botToken,
    { kind: "unsubscribe", presetIds },
  );
  await runAction({
    tickers: parsed.tickers,
    initialCoins: presetCoins,
    actionType: "unsubscribe",
    actionPayload: { presetIds },
    resolutionScope: "tracked",
  });
}

async function handleSet(
  db: D1Database,
  chatId: string,
  username: string | null,
  actorUserId: string | null,
  args: string,
  botToken: string,
): Promise<void> {
  const parsed = parseSetCommand(args);
  if ("error" in parsed) {
    await replyToChat(chatId, escapeHtml(parsed.error), botToken);
    return;
  }

  if (parsed.ticker.toLowerCase() === "all") {
    const globalError = validateGlobalSetCommand(parsed);
    if (globalError) {
      await replyToChat(chatId, escapeHtml(globalError), botToken);
      return;
    }
    await applyGlobalSetting(db, chatId, username, parsed);
    const subscriber = await loadSubscriberByChat(db, chatId);
    await replyToChat(chatId, buildGlobalAlertSummaryMessage("Updated all-stablecoin alerts.", subscriber), botToken);
    return;
  }

  const runAction = makeActionRunner({ db, chatId, username, initiatorUserId: actorUserId }, botToken);
  await runAction({ tickers: [parsed.ticker], actionType: "set", actionPayload: parsed });
}

async function handleMute(
  db: D1Database,
  chatId: string,
  username: string | null,
  args: string,
  botToken: string,
): Promise<void> {
  const parsed = parseQuietHours(args);
  if ("error" in parsed) {
    await replyToChat(chatId, escapeHtml(parsed.error), botToken);
    return;
  }
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: {
      enabled: true,
      startHourUtc: parsed.startHourUtc,
      endHourUtc: parsed.endHourUtc,
    },
  });
  await replyToChat(
    chatId,
    escapeHtml(
      `Quiet hours enabled: ${formatQuietHours(parsed.startHourUtc, parsed.endHourUtc)}.\n` +
        "Messages will still arrive, but Telegram notifications will be silenced in that window.",
    ),
    botToken,
  );
}

async function handleUnmuteHours(
  db: D1Database,
  chatId: string,
  username: string | null,
  botToken: string,
): Promise<void> {
  await upsertSubscriberRow(db, {
    chatId,
    username,
    nowSec: unixNow(),
    quietHours: { enabled: false },
  });
  await replyToChat(chatId, "Quiet hours disabled.", botToken);
}

async function handleUnsnooze(
  db: D1Database,
  chatId: string,
  username: string | null,
  botToken: string,
): Promise<void> {
  await clearAlertSnooze(db, chatId, username);
  await replyToChat(chatId, "Alert snooze cleared.", botToken);
}

async function handleDisambiguationReply(
  db: D1Database,
  chatId: string,
  text: string,
  pending: PendingAction,
  botToken: string,
  username: string | null,
): Promise<void> {
  if (pending.actionType === "confirm-bulk") {
    // confirm-bulk uses inline buttons; plain text replies are handled upstream.
    return;
  }
  const selectedIndices = parseDisambiguationReply(text, pending.candidates.length);
  if (!selectedIndices) {
    const reminder = [
      'Reply with the number(s) you want, e.g. "1" or "1,2".',
      "Use /cancel to abandon this selection.",
      formatDisambiguation(pending.ambiguousTicker, pending.candidates),
    ].join("\n\n");
    await replyToChat(chatId, escapeHtml(reminder), botToken);
    return;
  }

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

async function replyToChat(
  chatId: string,
  message: string,
  botToken: string,
  options: { replyMarkup?: unknown } = {},
): Promise<void> {
  const chunks = splitMessage(message);
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    // Only attach the reply markup to the last chunk so a multi-part message
    // does not produce multiple inline keyboards.
    const isLastChunk = i === chunks.length - 1;
    const result = await sendToChat(chatId, chunk, botToken, {
      disableWebPagePreview: true,
      ...(isLastChunk && options.replyMarkup != null ? { replyMarkup: options.replyMarkup } : {}),
    });
    if (!result.ok) {
      console.warn(`[telegram-webhook] Reply to ${chatId} failed: ${result.errorClass ?? "unknown"} (${result.statusCode})`);
      if (result.errorClass === "rate_limit") return;
    }
  }
}
