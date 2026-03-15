import { timingSafeCompare } from "../lib/auth";
import { escapeHtml, sendToChat } from "../lib/telegram";
import {
  resolveTicker,
  parseSubscribeArgs,
  validateSubscribeArgs,
  formatDisambiguation,
  parseDisambiguationReply,
  type ResolvedCoin,
} from "../lib/telegram-alerts";
import {
  HELP_MESSAGE,
  START_MESSAGE,
  type CoinResolution,
  type PendingAction,
  type PendingDisambiguationRow,
  type SubscriptionRow,
  type TelegramWebhookUpdate,
} from "./telegram-webhook-shared";
import {
  buildGlobalAlertSummaryMessage,
  buildListMessage,
  buildNotFoundMessage,
  buildSubscriptionSummaryMessage,
  buildUnsubscribeSuccessMessage,
  formatQuietHours,
} from "./telegram-webhook-messages";
import {
  dedupeCoins,
  parseCommand,
  parsePendingDisambiguation,
  parseQuietHours,
  parseSetCommand,
} from "./telegram-webhook-parsing";
import {
  applyGlobalSetting,
  applySettingToSubscriptions,
  clearPendingDisambiguation,
  loadSubscriberByChat,
  loadSubscriptionsByIds,
  persistPendingDisambiguation,
  removeSubscriptions,
  unixNow,
  upsertGlobalAlertTypes,
  upsertSubscriberAndSubscriptions,
  validateGlobalSetCommand,
} from "./telegram-webhook-store";

export async function handleTelegramWebhook(
  db: D1Database,
  request: Request,
  webhookSecret?: string,
  botToken?: string,
): Promise<Response> {
  const ok = () => new Response("ok", { status: 200 });

  const url = new URL(request.url);
  const providedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
    ?? url.searchParams.get("secret") // backward compat during migration
    ?? "";
  if (!webhookSecret || !(await timingSafeCompare(providedSecret, webhookSecret))) {
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

  const chatId = update.message?.chat?.id?.toString();
  const text = update.message?.text?.trim();
  const username = update.message?.chat?.username ?? null;
  if (!chatId || !text) return ok();

  const reply = async (message: string) => {
    await replyToChat(chatId, message, botToken);
  };

  try {
    const pendingRow = await db
      .prepare("SELECT action_type, action_payload, alert_types, resolved_ids, ambiguous_ticker, candidates, remaining_tickers, expires_at FROM telegram_pending_disambiguation WHERE chat_id = ?")
      .bind(chatId)
      .first<PendingDisambiguationRow>();

    const pendingAction = pendingRow ? parsePendingDisambiguation(pendingRow) : null;
    const pendingActive = Boolean(pendingRow && pendingAction && unixNow() < pendingRow.expires_at);

    if (pendingRow && !pendingActive) {
      await clearPendingDisambiguation(db, chatId);
    }

    const parsedCommand = text.startsWith("/") ? parseCommand(text) : null;
    if (pendingActive && pendingAction) {
      if (!parsedCommand) {
        await handleDisambiguationReply(db, chatId, text, pendingAction, botToken, username);
        return ok();
      }

      switch (parsedCommand.command) {
        case "/cancel":
          await clearPendingDisambiguation(db, chatId);
          await reply("Pending selection cleared.");
          return ok();
        case "/help":
          await reply(HELP_MESSAGE);
          return ok();
        case "/list":
          await handleList(db, chatId, botToken);
          return ok();
        case "/start":
          await reply(START_MESSAGE);
          return ok();
        case "/subscribe":
        case "/unsubscribe":
        case "/set":
        case "/mute":
        case "/unmutehours":
          await clearPendingDisambiguation(db, chatId);
          break;
        default:
          await reply(`You have a pending selection. Reply with the number(s) you want, or use /cancel.

${escapeHtml(formatDisambiguation(pendingAction.ambiguousTicker, pendingAction.candidates))}`);
          return ok();
      }
    }

    if (!parsedCommand) return ok();

    switch (parsedCommand.command) {
      case "/start":
        await reply(START_MESSAGE);
        break;
      case "/help":
        await reply(HELP_MESSAGE);
        break;
      case "/list":
        await handleList(db, chatId, botToken);
        break;
      case "/subscribe":
        await handleSubscribe(db, chatId, username, parsedCommand.args, botToken);
        break;
      case "/unsubscribe":
        await handleUnsubscribe(db, chatId, parsedCommand.args, botToken);
        break;
      case "/set":
        await handleSet(db, chatId, username, parsedCommand.args, botToken);
        break;
      case "/mute":
        await handleMute(db, chatId, username, parsedCommand.args, botToken);
        break;
      case "/unmutehours":
        await handleUnmuteHours(db, chatId, username, botToken);
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
}

async function handleList(
  db: D1Database,
  chatId: string,
  botToken: string,
): Promise<void> {
  const subscriber = await loadSubscriberByChat(db, chatId);

  const subscriptions = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band, safety_mode, depeg_worsening_bps_step
         FROM telegram_subscriptions
        WHERE chat_id = ?
        ORDER BY stablecoin_id`,
    )
    .bind(chatId)
    .all<SubscriptionRow>();

  const rows = subscriptions.results ?? [];
  if (!subscriber && rows.length === 0) {
    await replyToChat(chatId, "No active subscriptions. Use /subscribe to get started.", botToken);
    return;
  }

  const message = buildListMessage(subscriber, rows);
  await replyToChat(chatId, message, botToken);
}

async function handleSubscribe(
  db: D1Database,
  chatId: string,
  username: string | null,
  args: string,
  botToken: string,
): Promise<void> {
  const parsed = parseSubscribeArgs(args);
  const validationError = validateSubscribeArgs(parsed);
  if (validationError) {
    if (parsed.invalidTypes.length > 0 && parsed.alertTypes.size > 0) {
      const invalidTicker = parsed.invalidTypes[0];
      const match = resolveTicker(invalidTicker);
      const suggestion = match.status === "not_found" ? match.suggestion : undefined;
      await replyToChat(chatId, buildNotFoundMessage(invalidTicker, suggestion), botToken);
      return;
    }

    await replyToChat(chatId, escapeHtml(validationError), botToken);
    return;
  }

  if (parsed.subscribeAll) {
    await upsertGlobalAlertTypes(db, chatId, username, parsed.alertTypes);
    const subscriber = await loadSubscriberByChat(db, chatId);
    await replyToChat(
      chatId,
      buildGlobalAlertSummaryMessage("Updated all-stablecoin subscriptions.", subscriber),
      botToken,
    );
    return;
  }

  const resolution = resolveCoinTargets(parsed.tickers);
  if (resolution.kind === "not_found") {
    await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
    return;
  }

  if (resolution.kind === "ambiguous") {
    await persistPendingDisambiguation(db, {
      chatId,
      actionType: "subscribe",
      actionPayload: { alertTypes: [...parsed.alertTypes] },
      alertTypes: parsed.alertTypes,
      resolvedCoins: resolution.coins,
      ambiguousTicker: resolution.ticker,
      candidates: resolution.candidates,
      remainingTickers: resolution.remainingTickers,
    });
    await replyToChat(chatId, escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)), botToken);
    return;
  }

  await upsertSubscriberAndSubscriptions(
    db,
    chatId,
    username,
    parsed.alertTypes,
    resolution.coins.map((coin) => coin.id),
  );

  const subscriptions = await loadSubscriptionsByIds(db, chatId, resolution.coins.map((coin) => coin.id));
  await replyToChat(
    chatId,
    buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions),
    botToken,
  );
}

async function handleUnsubscribe(
  db: D1Database,
  chatId: string,
  args: string,
  botToken: string,
): Promise<void> {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    await replyToChat(chatId, "Specify ticker(s) to unsubscribe, or use /unsubscribe all", botToken);
    return;
  }

  if (trimmedArgs.toLowerCase() === "all") {
    const now = unixNow();
    await db.batch([
      db.prepare("DELETE FROM telegram_subscriptions WHERE chat_id = ?").bind(chatId),
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
      db.prepare(
        `UPDATE telegram_subscribers
            SET alert_dews = 0,
                alert_depeg = 0,
                alert_safety = 0,
                global_alert_dews = 0,
                global_alert_depeg = 0,
                global_alert_safety = 0,
                last_active_at = ?
          WHERE chat_id = ?`,
      ).bind(now, chatId),
    ]);
    await replyToChat(chatId, "Removed all subscriptions.", botToken);
    return;
  }

  const resolution = resolveCoinTargets(trimmedArgs.split(/[\s,]+/).filter(Boolean));
  if (resolution.kind === "not_found") {
    await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
    return;
  }

  if (resolution.kind === "ambiguous") {
    await persistPendingDisambiguation(db, {
      chatId,
      actionType: "unsubscribe",
      actionPayload: {},
      resolvedCoins: resolution.coins,
      ambiguousTicker: resolution.ticker,
      candidates: resolution.candidates,
      remainingTickers: resolution.remainingTickers,
    });
    await replyToChat(chatId, escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)), botToken);
    return;
  }

  await removeSubscriptions(db, chatId, resolution.coins.map((coin) => coin.id));
  await replyToChat(chatId, buildUnsubscribeSuccessMessage(resolution.coins), botToken);
}

async function handleSet(
  db: D1Database,
  chatId: string,
  username: string | null,
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
    await replyToChat(
      chatId,
      buildGlobalAlertSummaryMessage("Updated all-stablecoin alerts.", subscriber),
      botToken,
    );
    return;
  }

  const resolution = resolveCoinTargets([parsed.ticker]);
  if (resolution.kind === "not_found") {
    await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
    return;
  }

  if (resolution.kind === "ambiguous") {
    await persistPendingDisambiguation(db, {
      chatId,
      actionType: "set",
      actionPayload: parsed,
      resolvedCoins: resolution.coins,
      ambiguousTicker: resolution.ticker,
      candidates: resolution.candidates,
      remainingTickers: resolution.remainingTickers,
    });
    await replyToChat(chatId, escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)), botToken);
    return;
  }

  await applySettingToSubscriptions(db, chatId, username, resolution.coins, parsed);
  const subscriptions = await loadSubscriptionsByIds(db, chatId, resolution.coins.map((coin) => coin.id));
  await replyToChat(
    chatId,
    buildSubscriptionSummaryMessage("Updated settings.", subscriptions),
    botToken,
  );
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

  const now = unixNow();
  await db
    .prepare(
      `INSERT INTO telegram_subscribers (
         chat_id, username, alert_dews, alert_depeg, alert_safety, created_at, last_active_at,
         quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc
       )
       VALUES (?, ?, 0, 0, 0, ?, ?, 1, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET
         username = COALESCE(excluded.username, telegram_subscribers.username),
         last_active_at = excluded.last_active_at,
         quiet_hours_enabled = 1,
         quiet_hours_start_utc = excluded.quiet_hours_start_utc,
         quiet_hours_end_utc = excluded.quiet_hours_end_utc`,
    )
    .bind(chatId, username, now, now, parsed.startHourUtc, parsed.endHourUtc)
    .run();

  await replyToChat(
    chatId,
    `Quiet hours enabled: ${formatQuietHours(parsed.startHourUtc, parsed.endHourUtc)} UTC.
Messages will still arrive, but Telegram notifications will be silenced in that window.`,
    botToken,
  );
}

async function handleUnmuteHours(
  db: D1Database,
  chatId: string,
  username: string | null,
  botToken: string,
): Promise<void> {
  const now = unixNow();
  await db
    .prepare(
      `INSERT INTO telegram_subscribers (
         chat_id, username, alert_dews, alert_depeg, alert_safety, created_at, last_active_at,
         quiet_hours_enabled, quiet_hours_start_utc, quiet_hours_end_utc
       )
       VALUES (?, ?, 0, 0, 0, ?, ?, 0, NULL, NULL)
       ON CONFLICT(chat_id) DO UPDATE SET
         username = COALESCE(excluded.username, telegram_subscribers.username),
         last_active_at = excluded.last_active_at,
         quiet_hours_enabled = 0,
         quiet_hours_start_utc = NULL,
         quiet_hours_end_utc = NULL`,
    )
    .bind(chatId, username, now, now)
    .run();

  await replyToChat(chatId, "Quiet hours disabled.", botToken);
}

async function handleDisambiguationReply(
  db: D1Database,
  chatId: string,
  text: string,
  pending: PendingAction,
  botToken: string,
  username: string | null,
): Promise<void> {
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
    selectedIndices
      .map((index) => pending.candidates[index])
      .filter((coin): coin is ResolvedCoin => Boolean(coin)),
  );

  switch (pending.actionType) {
    case "subscribe": {
      const resolution = resolveCoinTargets(
        pending.remainingTickers,
        dedupeCoins([...pending.resolvedCoins, ...selectedCoins]),
      );

      if (resolution.kind === "not_found") {
        await clearPendingDisambiguation(db, chatId);
        await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
        return;
      }

      if (resolution.kind === "ambiguous") {
        await persistPendingDisambiguation(db, {
          chatId,
          actionType: "subscribe",
          actionPayload: { alertTypes: [...pending.alertTypes] },
          alertTypes: pending.alertTypes,
          resolvedCoins: resolution.coins,
          ambiguousTicker: resolution.ticker,
          candidates: resolution.candidates,
          remainingTickers: resolution.remainingTickers,
        });
        await replyToChat(chatId, escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)), botToken);
        return;
      }

      await upsertSubscriberAndSubscriptions(
        db,
        chatId,
        username,
        pending.alertTypes,
        resolution.coins.map((coin) => coin.id),
        { clearPending: true },
      );
      const subscriptions = await loadSubscriptionsByIds(db, chatId, resolution.coins.map((coin) => coin.id));
      await replyToChat(
        chatId,
        buildSubscriptionSummaryMessage("Updated subscriptions.", subscriptions),
        botToken,
      );
      return;
    }
    case "unsubscribe": {
      const resolution = resolveCoinTargets(
        pending.remainingTickers,
        dedupeCoins([...pending.resolvedCoins, ...selectedCoins]),
      );

      if (resolution.kind === "not_found") {
        await clearPendingDisambiguation(db, chatId);
        await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
        return;
      }

      if (resolution.kind === "ambiguous") {
        await persistPendingDisambiguation(db, {
          chatId,
          actionType: "unsubscribe",
          actionPayload: {},
          resolvedCoins: resolution.coins,
          ambiguousTicker: resolution.ticker,
          candidates: resolution.candidates,
          remainingTickers: resolution.remainingTickers,
        });
        await replyToChat(chatId, escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)), botToken);
        return;
      }

      await clearPendingDisambiguation(db, chatId);
      await removeSubscriptions(db, chatId, resolution.coins.map((coin) => coin.id));
      await replyToChat(chatId, buildUnsubscribeSuccessMessage(resolution.coins), botToken);
      return;
    }
    case "set": {
      const resolution = resolveCoinTargets(
        pending.remainingTickers,
        dedupeCoins([...pending.resolvedCoins, ...selectedCoins]),
      );

      if (resolution.kind === "not_found") {
        await clearPendingDisambiguation(db, chatId);
        await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
        return;
      }

      if (resolution.kind === "ambiguous") {
        await persistPendingDisambiguation(db, {
          chatId,
          actionType: "set",
          actionPayload: pending.command,
          resolvedCoins: resolution.coins,
          ambiguousTicker: resolution.ticker,
          candidates: resolution.candidates,
          remainingTickers: resolution.remainingTickers,
        });
        await replyToChat(chatId, escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)), botToken);
        return;
      }

      await clearPendingDisambiguation(db, chatId);
      await applySettingToSubscriptions(db, chatId, username, resolution.coins, pending.command);
      const subscriptions = await loadSubscriptionsByIds(db, chatId, resolution.coins.map((coin) => coin.id));
      await replyToChat(
        chatId,
        buildSubscriptionSummaryMessage("Updated settings.", subscriptions),
        botToken,
      );
      return;
    }
  }
}

function resolveCoinTargets(
  tickers: string[],
  initialCoins: ResolvedCoin[] = [],
): CoinResolution {
  const coins = dedupeCoins(initialCoins);
  const seenIds = new Set(coins.map((coin) => coin.id));

  for (let index = 0; index < tickers.length; index += 1) {
    const ticker = tickers[index];
    const match = resolveTicker(ticker);

    if (match.status === "not_found") {
      return { kind: "not_found", ticker, suggestion: match.suggestion };
    }

    if (match.status === "ambiguous") {
      return {
        kind: "ambiguous",
        ticker,
        candidates: match.matches,
        coins,
        remainingTickers: tickers.slice(index + 1),
      };
    }

    const coin = match.matches[0];
    if (seenIds.has(coin.id)) continue;
    seenIds.add(coin.id);
    coins.push(coin);
  }

  return { kind: "complete", coins };
}

async function replyToChat(
  chatId: string,
  message: string,
  botToken: string,
): Promise<void> {
  await sendToChat(chatId, message, botToken, { disableWebPagePreview: true });
}
