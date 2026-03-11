import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { escapeHtml, sendToChat } from "../lib/telegram";
import {
  resolveTicker,
  parseSubscribeArgs,
  validateSubscribeArgs,
  formatDisambiguation,
  parseDisambiguationReply,
  type ResolvedCoin,
} from "../lib/telegram-alerts";

const START_MESSAGE = `<b>Welcome to PharosWatchBot</b>

I send opt-in alerts for the stablecoins you follow, or for all tracked stablecoins by alert type.

<b>Alert types</b>
- <b>dews</b> — DEWS reaches ALERT, WARNING, or DANGER
- <b>depeg</b> — Depeg triggered, worsened, or resolved
- <b>safety</b> — Safety grade changes

<b>Quick start</b>
<code>/subscribe dews depeg USDC BOLD</code>
<code>/subscribe safety all</code>
<code>/set USDC depeg-step 250</code>
<code>/mute 22-07</code>

Use /help for commands.`;

const HELP_MESSAGE = `<b>Commands</b>

<code>/subscribe &lt;types&gt; &lt;tickers&gt;</code>
Enable alert types for one or more coins

<code>/subscribe &lt;types&gt; all</code>
Enable alert types across all tracked stablecoins

<code>/unsubscribe &lt;tickers&gt;</code>
Remove specific coin subscriptions

<code>/unsubscribe all</code>
Remove all per-coin and all-stablecoin subscriptions

<code>/set &lt;ticker&gt; &lt;setting&gt; &lt;value&gt;</code>
Examples:
<code>/set USDT dews WARNING</code>
<code>/set all depeg off</code>
<code>/set DAI safety downgrade-only</code>
<code>/set USDC depeg-step 250</code>

<code>/mute 22-07</code>
Quiet hours in UTC (notifications silenced, messages still delivered)

<code>/unmutehours</code>
Disable quiet hours

<code>/list</code>
Show current subscriptions and settings

<code>/cancel</code>
Cancel a pending selection`;

const DISAMBIGUATION_TTL_SEC = 5 * 60;

type PendingActionType = "subscribe" | "unsubscribe" | "set";

type ParsedSetCommand =
  | { ticker: string; setting: "dews"; enabled: boolean; minBand: "WARNING" | "DANGER" | null }
  | { ticker: string; setting: "safety"; enabled: boolean; mode: "downgrade-only" | "upgrade-only" | null }
  | { ticker: string; setting: "depeg"; enabled: boolean }
  | { ticker: string; setting: "depeg-step"; enabled: true; step: 100 | 250 | 500 | null };

interface TelegramWebhookUpdate {
  update_id?: number;
  message?: {
    chat?: {
      id?: number;
      username?: string;
    };
    text?: string;
  };
}

interface PendingDisambiguationRow {
  action_type?: string | null;
  action_payload?: string | null;
  alert_types: string;
  resolved_ids: string;
  ambiguous_ticker: string;
  candidates: string;
  remaining_tickers: string;
  expires_at: number;
}

interface SubscriberRow {
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  global_alert_dews?: number | null;
  global_alert_depeg?: number | null;
  global_alert_safety?: number | null;
  quiet_hours_enabled: number | null;
  quiet_hours_start_utc: number | null;
  quiet_hours_end_utc: number | null;
}

interface SubscriptionRow {
  stablecoin_id: string;
  alert_dews: number;
  alert_depeg: number;
  alert_safety: number;
  dews_min_band: string | null;
  safety_mode: string | null;
  depeg_worsening_bps_step: number | null;
}

type CoinResolution =
  | { kind: "complete"; coins: ResolvedCoin[] }
  | {
      kind: "ambiguous";
      ticker: string;
      candidates: ResolvedCoin[];
      coins: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      kind: "not_found";
      ticker: string;
      suggestion?: ResolvedCoin;
    };

type PendingAction =
  | {
      actionType: "subscribe";
      alertTypes: Set<string>;
      resolvedCoins: ResolvedCoin[];
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "unsubscribe";
      resolvedCoins: ResolvedCoin[];
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    }
  | {
      actionType: "set";
      command: ParsedSetCommand;
      resolvedCoins: ResolvedCoin[];
      ambiguousTicker: string;
      candidates: ResolvedCoin[];
      remainingTickers: string[];
    };

const STABLECOIN_BY_ID = new Map<string, ResolvedCoin>(
  TRACKED_STABLECOINS.map((coin) => [
    coin.id,
    {
      id: coin.id,
      symbol: coin.symbol,
      name: coin.name,
    },
  ]),
);

export async function handleTelegramWebhook(
  db: D1Database,
  request: Request,
  webhookSecret?: string,
  botToken?: string,
): Promise<Response> {
  const ok = () => new Response("ok", { status: 200 });

  const url = new URL(request.url);
  if (!webhookSecret || url.searchParams.get("secret") !== webhookSecret) {
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
      .prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = ?")
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

function parseCommand(text: string): { command: string; args: string } {
  const spaceIdx = text.indexOf(" ");
  const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx))
    .toLowerCase()
    .replace(/@\w+$/, "");
  const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();
  return { command, args };
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

async function persistPendingDisambiguation(
  db: D1Database,
  input: {
    chatId: string;
    actionType: PendingActionType;
    actionPayload: Record<string, unknown>;
    resolvedCoins: ResolvedCoin[];
    ambiguousTicker: string;
    candidates: ResolvedCoin[];
    remainingTickers: string[];
    alertTypes?: Set<string>;
  },
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id,
        action_type,
        action_payload,
        alert_types,
        resolved_ids,
        ambiguous_ticker,
        candidates,
        remaining_tickers,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        action_type = excluded.action_type,
        action_payload = excluded.action_payload,
        alert_types = excluded.alert_types,
        resolved_ids = excluded.resolved_ids,
        ambiguous_ticker = excluded.ambiguous_ticker,
        candidates = excluded.candidates,
        remaining_tickers = excluded.remaining_tickers,
        expires_at = excluded.expires_at
    `)
    .bind(
      input.chatId,
      input.actionType,
      JSON.stringify(input.actionPayload),
      JSON.stringify(Array.from(input.alertTypes ?? [])),
      JSON.stringify(dedupeCoins(input.resolvedCoins).map((coin) => coin.id)),
      input.ambiguousTicker,
      JSON.stringify(input.candidates),
      JSON.stringify(input.remainingTickers),
      unixNow() + DISAMBIGUATION_TTL_SEC,
    )
    .run();
}

async function loadSubscriberByChat(
  db: D1Database,
  chatId: string,
): Promise<SubscriberRow | null> {
  return db
    .prepare(
      `SELECT
         alert_dews,
         alert_depeg,
         alert_safety,
         global_alert_dews,
         global_alert_depeg,
         global_alert_safety,
         quiet_hours_enabled,
         quiet_hours_start_utc,
         quiet_hours_end_utc
       FROM telegram_subscribers
      WHERE chat_id = ?`,
    )
    .bind(chatId)
    .first<SubscriberRow>();
}

async function upsertGlobalAlertTypes(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
): Promise<void> {
  const now = unixNow();
  await db
    .prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        created_at,
        last_active_at
      )
      VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        global_alert_dews = MAX(telegram_subscribers.global_alert_dews, excluded.global_alert_dews),
        global_alert_depeg = MAX(telegram_subscribers.global_alert_depeg, excluded.global_alert_depeg),
        global_alert_safety = MAX(telegram_subscribers.global_alert_safety, excluded.global_alert_safety),
        last_active_at = excluded.last_active_at
    `)
    .bind(
      chatId,
      username,
      alertTypes.has("dews") ? 1 : 0,
      alertTypes.has("depeg") ? 1 : 0,
      alertTypes.has("safety") ? 1 : 0,
      now,
      now,
    )
    .run();
}

async function upsertSubscriberAndSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  alertTypes: Set<string>,
  stablecoinIds: string[],
  options?: { clearPending?: boolean },
): Promise<void> {
  const now = unixNow();
  const alertDews = alertTypes.has("dews") ? 1 : 0;
  const alertDepeg = alertTypes.has("depeg") ? 1 : 0;
  const alertSafety = alertTypes.has("safety") ? 1 : 0;
  const uniqueStablecoinIds = Array.from(new Set(stablecoinIds));

  const statements: D1PreparedStatement[] = [];
  if (options?.clearPending) {
    statements.push(
      db.prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?").bind(chatId),
    );
  }

  statements.push(
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        created_at,
        last_active_at
      )
      VALUES (?, ?, ?, ?, ?, 0, 0, 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        alert_dews = MAX(telegram_subscribers.alert_dews, excluded.alert_dews),
        alert_depeg = MAX(telegram_subscribers.alert_depeg, excluded.alert_depeg),
        alert_safety = MAX(telegram_subscribers.alert_safety, excluded.alert_safety),
        last_active_at = excluded.last_active_at
    `).bind(
      chatId,
      username,
      alertDews,
      alertDepeg,
      alertSafety,
      now,
      now,
    ),
  );

  for (const stablecoinId of uniqueStablecoinIds) {
    statements.push(
      db.prepare(`
        INSERT INTO telegram_subscriptions (
          chat_id,
          stablecoin_id,
          alert_dews,
          alert_depeg,
          alert_safety
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
          alert_dews = MAX(telegram_subscriptions.alert_dews, excluded.alert_dews),
          alert_depeg = MAX(telegram_subscriptions.alert_depeg, excluded.alert_depeg),
          alert_safety = MAX(telegram_subscriptions.alert_safety, excluded.alert_safety)
      `).bind(chatId, stablecoinId, alertDews, alertDepeg, alertSafety),
    );
  }

  await db.batch(statements);
}

async function applySettingToSubscriptions(
  db: D1Database,
  chatId: string,
  username: string | null,
  coins: ResolvedCoin[],
  command: ParsedSetCommand,
): Promise<void> {
  const now = unixNow();
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        created_at,
        last_active_at
      )
      VALUES (?, ?, 0, 0, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        last_active_at = excluded.last_active_at
    `).bind(chatId, username, now, now),
  ];

  const enableGlobalTypes = new Set<string>();
  if (command.setting === "dews" && command.enabled) enableGlobalTypes.add("dews");
  if (command.setting === "depeg" && command.enabled) enableGlobalTypes.add("depeg");
  if (command.setting === "depeg-step") enableGlobalTypes.add("depeg");
  if (command.setting === "safety" && command.enabled) enableGlobalTypes.add("safety");

  if (enableGlobalTypes.size > 0) {
    statements.push(
      db.prepare(
        `UPDATE telegram_subscribers
            SET alert_dews = MAX(alert_dews, ?),
                alert_depeg = MAX(alert_depeg, ?),
                alert_safety = MAX(alert_safety, ?)
          WHERE chat_id = ?`,
      ).bind(
        enableGlobalTypes.has("dews") ? 1 : 0,
        enableGlobalTypes.has("depeg") ? 1 : 0,
        enableGlobalTypes.has("safety") ? 1 : 0,
        chatId,
      ),
    );
  }

  for (const coin of coins) {
    switch (command.setting) {
      case "dews":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band
            )
            VALUES (?, ?, ?, 0, 0, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_dews = excluded.alert_dews,
              dews_min_band = excluded.dews_min_band
          `).bind(chatId, coin.id, command.enabled ? 1 : 0, command.minBand),
        );
        break;
      case "safety":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, safety_mode
            )
            VALUES (?, ?, 0, 0, ?, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_safety = excluded.alert_safety,
              safety_mode = excluded.safety_mode
          `).bind(chatId, coin.id, command.enabled ? 1 : 0, command.mode),
        );
        break;
      case "depeg":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
            )
            VALUES (?, ?, 0, ?, 0, NULL)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_depeg = excluded.alert_depeg,
              depeg_worsening_bps_step = CASE WHEN excluded.alert_depeg = 0 THEN NULL ELSE telegram_subscriptions.depeg_worsening_bps_step END
          `).bind(chatId, coin.id, command.enabled ? 1 : 0),
        );
        break;
      case "depeg-step":
        statements.push(
          db.prepare(`
            INSERT INTO telegram_subscriptions (
              chat_id, stablecoin_id, alert_dews, alert_depeg, alert_safety, depeg_worsening_bps_step
            )
            VALUES (?, ?, 0, 1, 0, ?)
            ON CONFLICT(chat_id, stablecoin_id) DO UPDATE SET
              alert_depeg = 1,
              depeg_worsening_bps_step = excluded.depeg_worsening_bps_step
          `).bind(chatId, coin.id, command.step),
        );
        break;
    }
  }

  await db.batch(statements);
}

function validateGlobalSetCommand(command: ParsedSetCommand): string | null {
  if (command.setting === "depeg-step") {
    return "Global all-stablecoin alerts do not support depeg-step. Use /set <ticker> depeg-step <value> for per-coin worsening alerts.";
  }
  if (command.setting === "dews" && command.enabled && command.minBand != null) {
    return "Global DEWS alerts only support the default ALERT threshold. Use /subscribe dews all or /set all dews off; WARNING/DANGER remain per-coin.";
  }
  if (command.setting === "safety" && command.enabled && command.mode != null) {
    return "Global safety alerts support all/off only. Upgrade-only and downgrade-only remain per-coin settings.";
  }
  return null;
}

async function applyGlobalSetting(
  db: D1Database,
  chatId: string,
  username: string | null,
  command: ParsedSetCommand,
): Promise<void> {
  const now = unixNow();
  const current = await loadSubscriberByChat(db, chatId);
  const next = {
    dews: current?.global_alert_dews ?? 0,
    depeg: current?.global_alert_depeg ?? 0,
    safety: current?.global_alert_safety ?? 0,
  };

  switch (command.setting) {
    case "dews":
      next.dews = command.enabled ? 1 : 0;
      break;
    case "depeg":
      next.depeg = command.enabled ? 1 : 0;
      break;
    case "safety":
      next.safety = command.enabled ? 1 : 0;
      break;
    case "depeg-step":
      throw new Error("Global depeg-step is not supported");
  }

  await db
    .prepare(`
      INSERT INTO telegram_subscribers (
        chat_id,
        username,
        alert_dews,
        alert_depeg,
        alert_safety,
        global_alert_dews,
        global_alert_depeg,
        global_alert_safety,
        created_at,
        last_active_at
      )
      VALUES (?, ?, 0, 0, 0, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = COALESCE(excluded.username, telegram_subscribers.username),
        global_alert_dews = excluded.global_alert_dews,
        global_alert_depeg = excluded.global_alert_depeg,
        global_alert_safety = excluded.global_alert_safety,
        last_active_at = excluded.last_active_at
    `)
    .bind(chatId, username, next.dews, next.depeg, next.safety, now, now)
    .run();
}

async function removeSubscriptions(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<void> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return;

  const now = unixNow();
  const placeholders = uniqueIds.map(() => "?").join(", ");
  await db.batch([
    db.prepare(
      `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (${placeholders})`,
    ).bind(chatId, ...uniqueIds),
    db.prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?").bind(now, chatId),
  ]);
}

async function clearPendingDisambiguation(
  db: D1Database,
  chatId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?")
    .bind(chatId)
    .run();
}

function parsePendingDisambiguation(pending: PendingDisambiguationRow): PendingAction | null {
  try {
    const actionType = (pending.action_type ?? "subscribe") as PendingActionType;
    const payload = pending.action_payload ? JSON.parse(pending.action_payload) as Record<string, unknown> : {};
    const legacyAlertTypes = new Set(parseStringArray(JSON.parse(pending.alert_types)));
    const resolvedIds = parseStringArray(JSON.parse(pending.resolved_ids));
    const candidates = parseResolvedCoins(JSON.parse(pending.candidates));
    const remainingTickers = parseStringArray(JSON.parse(pending.remaining_tickers));
    if (candidates.length === 0) return null;

    const resolvedCoins = dedupeCoins(
      resolvedIds.map((id) => STABLECOIN_BY_ID.get(id) ?? { id, symbol: id, name: id }),
    );

    if (actionType === "subscribe") {
      const actionAlertTypes = new Set(
        Array.isArray(payload.alertTypes)
          ? parseStringArray(payload.alertTypes)
          : Array.from(legacyAlertTypes),
      );
      return {
        actionType,
        alertTypes: actionAlertTypes,
        resolvedCoins,
        ambiguousTicker: pending.ambiguous_ticker,
        candidates,
        remainingTickers,
      };
    }

    if (actionType === "unsubscribe") {
      return {
        actionType,
        resolvedCoins,
        ambiguousTicker: pending.ambiguous_ticker,
        candidates,
        remainingTickers,
      };
    }

    const setCommand = parseStoredSetCommand(payload);
    if (!setCommand) return null;
    return {
      actionType: "set",
      command: setCommand,
      resolvedCoins,
      ambiguousTicker: pending.ambiguous_ticker,
      candidates,
      remainingTickers,
    };
  } catch {
    return null;
  }
}

function parseStoredSetCommand(payload: Record<string, unknown>): ParsedSetCommand | null {
  const ticker = typeof payload.ticker === "string" ? payload.ticker : "unknown";
  const setting = typeof payload.setting === "string" ? payload.setting : null;
  switch (setting) {
    case "dews":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
        minBand: payload.minBand === "WARNING" || payload.minBand === "DANGER" ? payload.minBand : null,
      };
    case "safety":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
        mode:
          payload.mode === "downgrade-only" || payload.mode === "upgrade-only"
            ? payload.mode
            : null,
      };
    case "depeg":
      return {
        ticker,
        setting,
        enabled: payload.enabled !== false,
      };
    case "depeg-step":
      return {
        ticker,
        setting,
        enabled: true,
        step: payload.step === 100 || payload.step === 250 || payload.step === 500 ? payload.step : null,
      };
    default:
      return null;
  }
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function parseResolvedCoins(value: unknown): ResolvedCoin[] {
  if (!Array.isArray(value)) return [];

  const coins: ResolvedCoin[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const coin = item as Partial<ResolvedCoin>;
    if (
      typeof coin.id !== "string" ||
      typeof coin.symbol !== "string" ||
      typeof coin.name !== "string"
    ) {
      continue;
    }
    coins.push({ id: coin.id, symbol: coin.symbol, name: coin.name });
  }
  return coins;
}

function dedupeCoins(coins: ResolvedCoin[]): ResolvedCoin[] {
  const deduped: ResolvedCoin[] = [];
  const seenIds = new Set<string>();

  for (const coin of coins) {
    if (seenIds.has(coin.id)) continue;
    seenIds.add(coin.id);
    deduped.push(coin);
  }

  return deduped;
}

function parseSetCommand(args: string): ParsedSetCommand | { error: string } {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) {
    return { error: "Usage: /set <ticker> <setting> <value>" };
  }

  const [ticker, rawSetting, ...valueParts] = tokens;
  const setting = rawSetting.toLowerCase();
  const value = valueParts.join(" ").toLowerCase();

  switch (setting) {
    case "dews": {
      if (value === "off") {
        return { ticker, setting: "dews", enabled: false, minBand: null };
      }
      if (value === "alert") {
        return { ticker, setting: "dews", enabled: true, minBand: null };
      }
      if (value === "warning") {
        return { ticker, setting: "dews", enabled: true, minBand: "WARNING" };
      }
      if (value === "danger") {
        return { ticker, setting: "dews", enabled: true, minBand: "DANGER" };
      }
      return { error: "DEWS values: off, ALERT, WARNING, DANGER" };
    }
    case "safety": {
      if (value === "off") {
        return { ticker, setting: "safety", enabled: false, mode: null };
      }
      if (value === "all") {
        return { ticker, setting: "safety", enabled: true, mode: null };
      }
      if (value === "downgrade-only" || value === "upgrade-only") {
        return { ticker, setting: "safety", enabled: true, mode: value };
      }
      return { error: "Safety values: off, all, downgrade-only, upgrade-only" };
    }
    case "depeg": {
      if (value === "on") {
        return { ticker, setting: "depeg", enabled: true };
      }
      if (value === "off") {
        return { ticker, setting: "depeg", enabled: false };
      }
      return { error: "Depeg values: on, off" };
    }
    case "depeg-step": {
      if (value === "off") {
        return { ticker, setting: "depeg-step", enabled: true, step: null };
      }
      const step = Number(value);
      if (step === 100 || step === 250 || step === 500) {
        return { ticker, setting: "depeg-step", enabled: true, step };
      }
      return { error: "Depeg-step values: off, 100, 250, 500" };
    }
    default:
      return { error: "Supported settings: dews, safety, depeg, depeg-step" };
  }
}

function parseQuietHours(args: string): { startHourUtc: number; endHourUtc: number } | { error: string } {
  const match = args.trim().match(/^(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return { error: "Usage: /mute <start>-<end> in UTC, e.g. /mute 22-07" };
  }

  const startHourUtc = Number(match[1]);
  const endHourUtc = Number(match[2]);
  if (
    !Number.isInteger(startHourUtc) ||
    !Number.isInteger(endHourUtc) ||
    startHourUtc < 0 ||
    startHourUtc > 23 ||
    endHourUtc < 0 ||
    endHourUtc > 23 ||
    startHourUtc === endHourUtc
  ) {
    return { error: "Quiet hours must be two different UTC hours between 0 and 23." };
  }

  return { startHourUtc, endHourUtc };
}

function buildNotFoundMessage(ticker: string, suggestion?: ResolvedCoin): string {
  const lines = [`Ticker "${ticker}" not found.`];
  if (suggestion) {
    lines.push(`Did you mean ${suggestion.symbol} (${suggestion.id})?`);
  }
  lines.push("You can also use the exact Pharos coin id when a ticker is ambiguous.");
  return escapeHtml(lines.join("\n"));
}

function buildUnsubscribeSuccessMessage(coins: ResolvedCoin[]): string {
  return escapeHtml([
    `Removed ${coins.length} coin subscription${coins.length === 1 ? "" : "s"}.`,
    "Coins:",
    formatCoinLines(coins),
  ].join("\n"));
}

function buildSubscriptionSummaryMessage(
  header: string,
  subscriptions: SubscriptionRow[],
): string {
  const lines = [header, `Coins (${subscriptions.length}):`];
  for (const row of subscriptions) {
    const coin = STABLECOIN_BY_ID.get(row.stablecoin_id);
    const label = coin ? `${coin.symbol} (${coin.id})` : row.stablecoin_id;
    lines.push(`- ${label}: ${describeSubscriptionSettings(row)}`);
  }
  return escapeHtml(lines.join("\n"));
}

function buildGlobalAlertSummaryMessage(
  header: string,
  subscriber: SubscriberRow | null,
): string {
  return escapeHtml([
    header,
    `All stablecoins: ${describeGlobalAlertSettings(subscriber)}`,
    `Quiet hours: ${
      subscriber?.quiet_hours_enabled
        ? `${formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc)} UTC`
        : "Off"
    }`,
  ].join("\n"));
}

function buildListMessage(
  subscriber: SubscriberRow | null,
  subscriptions: SubscriptionRow[],
): string {
  if (!subscriber && subscriptions.length === 0) {
    return "No active subscriptions. Use /subscribe to get started.";
  }

  const lines = [
    `All stablecoins: ${describeGlobalAlertSettings(subscriber)}`,
    `Quiet hours: ${
      subscriber?.quiet_hours_enabled
        ? `${formatQuietHours(subscriber.quiet_hours_start_utc, subscriber.quiet_hours_end_utc)} UTC`
        : "Off"
    }`,
    `Coins (${subscriptions.length}):`,
  ];

  if (subscriptions.length === 0) {
    lines.push("None");
  } else {
    const sorted = [...subscriptions].sort((a, b) => {
      const aCoin = STABLECOIN_BY_ID.get(a.stablecoin_id);
      const bCoin = STABLECOIN_BY_ID.get(b.stablecoin_id);
      const aSymbol = aCoin?.symbol ?? a.stablecoin_id;
      const bSymbol = bCoin?.symbol ?? b.stablecoin_id;
      return aSymbol.localeCompare(bSymbol) || a.stablecoin_id.localeCompare(b.stablecoin_id);
    });
    for (const row of sorted) {
      const coin = STABLECOIN_BY_ID.get(row.stablecoin_id);
      const label = coin ? `${coin.symbol} (${coin.id})` : row.stablecoin_id;
      lines.push(`- ${label}: ${describeSubscriptionSettings(row)}`);
    }
  }

  return escapeHtml(lines.join("\n"));
}

function describeSubscriptionSettings(row: SubscriptionRow): string {
  const labels: string[] = [];

  if (row.alert_dews) {
    labels.push(row.dews_min_band ? `DEWS>=${row.dews_min_band}` : "DEWS");
  }
  if (row.alert_depeg) {
    labels.push(
      row.depeg_worsening_bps_step != null
        ? `Depeg +${row.depeg_worsening_bps_step}bps`
        : "Depeg",
    );
  }
  if (row.alert_safety) {
    if (row.safety_mode === "downgrade-only") {
      labels.push("Safety downgrade-only");
    } else if (row.safety_mode === "upgrade-only") {
      labels.push("Safety upgrade-only");
    } else {
      labels.push("Safety");
    }
  }

  return labels.join(", ") || "Muted";
}

function describeGlobalAlertSettings(subscriber: SubscriberRow | null): string {
  if (!subscriber) return "None";
  const labels: string[] = [];

  if (subscriber.global_alert_dews) {
    labels.push("DEWS");
  }
  if (subscriber.global_alert_depeg) {
    labels.push("Depeg");
  }
  if (subscriber.global_alert_safety) {
    labels.push("Safety");
  }

  return labels.join(", ") || "None";
}

function formatCoinLines(coins: ResolvedCoin[]): string {
  return coins.map((coin) => `- ${coin.symbol} (${coin.id})`).join("\n") || "None";
}

function formatQuietHours(startHourUtc: number | null | undefined, endHourUtc: number | null | undefined): string {
  if (startHourUtc == null || endHourUtc == null) return "Off";
  return `${String(startHourUtc).padStart(2, "0")}-${String(endHourUtc).padStart(2, "0")}`;
}

async function loadSubscriptionsByIds(
  db: D1Database,
  chatId: string,
  stablecoinIds: string[],
): Promise<SubscriptionRow[]> {
  const uniqueIds = Array.from(new Set(stablecoinIds));
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const result = await db
    .prepare(
      `SELECT stablecoin_id, alert_dews, alert_depeg, alert_safety, dews_min_band, safety_mode, depeg_worsening_bps_step
         FROM telegram_subscriptions
        WHERE chat_id = ?
          AND stablecoin_id IN (${placeholders})
        ORDER BY stablecoin_id`,
    )
    .bind(chatId, ...uniqueIds)
    .all<SubscriptionRow>();
  return result.results ?? [];
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

async function replyToChat(
  chatId: string,
  message: string,
  botToken: string,
): Promise<void> {
  await sendToChat(chatId, message, botToken, { disableWebPagePreview: true });
}
