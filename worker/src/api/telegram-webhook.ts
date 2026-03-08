import { TRACKED_STABLECOINS } from "@shared/lib/stablecoins";
import { escapeHtml, sendToChat } from "../lib/telegram";
import {
  resolveTicker,
  parseSubscribeArgs,
  validateSubscribeArgs,
  formatDisambiguation,
  parseDisambiguationReply,
  formatListOutput,
  type ResolvedCoin,
} from "../lib/telegram-alerts";

const START_MESSAGE = `<b>Welcome to PharosWatcher</b>

I send you alerts when stablecoin risk signals change for the coins you choose.

<b>Alert types:</b>
- <b>dews</b> — DEWS threat level reaches ALERT, WARNING, or DANGER
- <b>depeg</b> — Depeg event triggered or resolved
- <b>safety</b> — Safety grade changes

<b>Quick start:</b>
/subscribe dews depeg USDC BOLD

Use /help for all commands.`;

const HELP_MESSAGE = `<b>Commands</b>

/subscribe &lt;types&gt; &lt;tickers&gt;
  Subscribe to alerts. Types: dews, depeg, safety
  Example: /subscribe dews depeg USDC BOLD

/unsubscribe &lt;tickers&gt;
  Remove coins from your subscriptions
  Example: /unsubscribe BOLD

/unsubscribe all
  Remove all subscriptions

/list
  Show your current subscriptions`;

const DISAMBIGUATION_TTL_SEC = 5 * 60;

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
}

interface SubscriptionRow {
  stablecoin_id: string;
}

type SubscribeResolution =
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

  // Deduplicate: Telegram may redeliver updates if our response is slow.
  // Atomic compare-and-swap ensures only the first invocation processes each update.
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

  const reply = async (msg: string) => {
    await replyToChat(chatId, msg, botToken);
  };

  try {
    const pending = await db
      .prepare("SELECT * FROM telegram_pending_disambiguation WHERE chat_id = ?")
      .bind(chatId)
      .first<PendingDisambiguationRow>();

    if (pending) {
      const now = unixNow();
      if (now < pending.expires_at) {
        await handleDisambiguationReply(db, chatId, text, pending, botToken);
        return ok();
      }

      await db
        .prepare("DELETE FROM telegram_pending_disambiguation WHERE chat_id = ?")
        .bind(chatId)
        .run();
    }

    if (!text.startsWith("/")) return ok();

    const spaceIdx = text.indexOf(" ");
    const command = (spaceIdx === -1 ? text : text.slice(0, spaceIdx))
      .toLowerCase()
      .replace(/@\w+$/, "");
    const args = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1).trim();

    switch (command) {
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
        await handleSubscribe(db, chatId, username, args, botToken);
        break;
      case "/unsubscribe":
        await handleUnsubscribe(db, chatId, args, botToken);
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
  const subscriber = await db
    .prepare("SELECT alert_dews, alert_depeg, alert_safety FROM telegram_subscribers WHERE chat_id = ?")
    .bind(chatId)
    .first<SubscriberRow>();

  if (!subscriber) {
    await replyToChat(chatId, "No active subscriptions. Use /subscribe to get started.", botToken);
    return;
  }

  const subscriptions = await db
    .prepare("SELECT stablecoin_id FROM telegram_subscriptions WHERE chat_id = ? ORDER BY stablecoin_id")
    .bind(chatId)
    .all<SubscriptionRow>();

  const coins = (subscriptions.results ?? [])
    .map((row) => {
      const coin = STABLECOIN_BY_ID.get(row.stablecoin_id);
      return coin ?? { id: row.stablecoin_id, symbol: row.stablecoin_id, name: row.stablecoin_id };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.id.localeCompare(b.id));

  if (!subscriber.alert_dews && !subscriber.alert_depeg && !subscriber.alert_safety && coins.length === 0) {
    await replyToChat(chatId, "No active subscriptions. Use /subscribe to get started.", botToken);
    return;
  }

  await replyToChat(
    chatId,
    escapeHtml(formatListOutput(
      {
        dews: Boolean(subscriber.alert_dews),
        depeg: Boolean(subscriber.alert_depeg),
        safety: Boolean(subscriber.alert_safety),
      },
      coins.map((coin) => ({ symbol: coin.symbol, id: coin.id })),
    )),
    botToken,
  );
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

  const resolution = resolveSubscribeTickers(parsed.tickers);
  if (resolution.kind === "not_found") {
    await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
    return;
  }

  if (resolution.kind === "ambiguous") {
    await persistPendingDisambiguation(
      db,
      chatId,
      parsed.alertTypes,
      resolution.coins,
      resolution.ticker,
      resolution.candidates,
      resolution.remainingTickers,
    );
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

  await replyToChat(
    chatId,
    buildSubscribeSuccessMessage(parsed.alertTypes, resolution.coins),
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
      db.prepare(
        "UPDATE telegram_subscribers SET alert_dews = 0, alert_depeg = 0, alert_safety = 0, last_active_at = ? WHERE chat_id = ?",
      ).bind(now, chatId),
    ]);
    await replyToChat(chatId, "Removed all subscriptions.", botToken);
    return;
  }

  const coinsToRemove: ResolvedCoin[] = [];
  const seenIds = new Set<string>();

  for (const ticker of trimmedArgs.split(/\s+/).filter(Boolean)) {
    const match = resolveTicker(ticker);
    if (match.status === "not_found") {
      await replyToChat(chatId, buildNotFoundMessage(ticker, match.suggestion), botToken);
      return;
    }

    const matches = match.status === "ambiguous" ? match.matches : [match.matches[0]];
    for (const coin of matches) {
      if (seenIds.has(coin.id)) continue;
      seenIds.add(coin.id);
      coinsToRemove.push(coin);
    }
  }

  if (coinsToRemove.length === 0) {
    await replyToChat(chatId, "No matching subscriptions found.", botToken);
    return;
  }

  const now = unixNow();
  const placeholders = coinsToRemove.map(() => "?").join(", ");
  await db.batch([
    db.prepare(
      `DELETE FROM telegram_subscriptions WHERE chat_id = ? AND stablecoin_id IN (${placeholders})`,
    ).bind(chatId, ...coinsToRemove.map((coin) => coin.id)),
    db.prepare("UPDATE telegram_subscribers SET last_active_at = ? WHERE chat_id = ?").bind(now, chatId),
  ]);

  await replyToChat(chatId, buildUnsubscribeSuccessMessage(coinsToRemove), botToken);
}

async function handleDisambiguationReply(
  db: D1Database,
  chatId: string,
  text: string,
  pending: PendingDisambiguationRow,
  botToken: string,
): Promise<void> {
  const parsedPending = parsePendingDisambiguation(pending);
  if (!parsedPending) {
    await clearPendingDisambiguation(db, chatId);
    await replyToChat(chatId, "That selection expired. Run /subscribe again.", botToken);
    return;
  }

  const selectedIndices = parseDisambiguationReply(text, parsedPending.candidates.length);
  if (!selectedIndices) {
    const reminder = [
      'Reply with the number(s) you want, e.g. "1" or "1,2".',
      formatDisambiguation(parsedPending.ambiguousTicker, parsedPending.candidates),
    ].join("\n\n");
    await replyToChat(chatId, escapeHtml(reminder), botToken);
    return;
  }

  const selectedCoins = dedupeCoins(
    selectedIndices
      .map((index) => parsedPending.candidates[index])
      .filter((coin): coin is ResolvedCoin => Boolean(coin)),
  );
  const resolution = resolveSubscribeTickers(
    parsedPending.remainingTickers,
    dedupeCoins([...parsedPending.resolvedCoins, ...selectedCoins]),
  );

  if (resolution.kind === "not_found") {
    await clearPendingDisambiguation(db, chatId);
    await replyToChat(chatId, buildNotFoundMessage(resolution.ticker, resolution.suggestion), botToken);
    return;
  }

  if (resolution.kind === "ambiguous") {
    await persistPendingDisambiguation(
      db,
      chatId,
      parsedPending.alertTypes,
      resolution.coins,
      resolution.ticker,
      resolution.candidates,
      resolution.remainingTickers,
    );
    await replyToChat(chatId, escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)), botToken);
    return;
  }

  await upsertSubscriberAndSubscriptions(
    db,
    chatId,
    null,
    parsedPending.alertTypes,
    resolution.coins.map((coin) => coin.id),
    { clearPending: true },
  );

  await replyToChat(
    chatId,
    buildSubscribeSuccessMessage(parsedPending.alertTypes, resolution.coins),
    botToken,
  );
}

function resolveSubscribeTickers(
  tickers: string[],
  initialCoins: ResolvedCoin[] = [],
): SubscribeResolution {
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
  chatId: string,
  alertTypes: Set<string>,
  resolvedCoins: ResolvedCoin[],
  ambiguousTicker: string,
  candidates: ResolvedCoin[],
  remainingTickers: string[],
): Promise<void> {
  await db
    .prepare(`
      INSERT INTO telegram_pending_disambiguation (
        chat_id,
        alert_types,
        resolved_ids,
        ambiguous_ticker,
        candidates,
        remaining_tickers,
        expires_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        alert_types = excluded.alert_types,
        resolved_ids = excluded.resolved_ids,
        ambiguous_ticker = excluded.ambiguous_ticker,
        candidates = excluded.candidates,
        remaining_tickers = excluded.remaining_tickers,
        expires_at = excluded.expires_at
    `)
    .bind(
      chatId,
      JSON.stringify(Array.from(alertTypes)),
      JSON.stringify(dedupeCoins(resolvedCoins).map((coin) => coin.id)),
      ambiguousTicker,
      JSON.stringify(candidates),
      JSON.stringify(remainingTickers),
      unixNow() + DISAMBIGUATION_TTL_SEC,
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
        created_at,
        last_active_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        username = excluded.username,
        alert_dews = MAX(alert_dews, ?),
        alert_depeg = MAX(alert_depeg, ?),
        alert_safety = MAX(alert_safety, ?),
        last_active_at = ?
    `).bind(
      chatId,
      username,
      alertDews,
      alertDepeg,
      alertSafety,
      now,
      now,
      alertDews,
      alertDepeg,
      alertSafety,
      now,
    ),
  );

  for (const stablecoinId of uniqueStablecoinIds) {
    statements.push(
      db.prepare("INSERT OR IGNORE INTO telegram_subscriptions (chat_id, stablecoin_id) VALUES (?, ?)")
        .bind(chatId, stablecoinId),
    );
  }

  await db.batch(statements);
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

function parsePendingDisambiguation(
  pending: PendingDisambiguationRow,
): {
  alertTypes: Set<string>;
  resolvedCoins: ResolvedCoin[];
  ambiguousTicker: string;
  candidates: ResolvedCoin[];
  remainingTickers: string[];
} | null {
  try {
    const alertTypes = new Set(parseStringArray(JSON.parse(pending.alert_types)));
    const resolvedIds = parseStringArray(JSON.parse(pending.resolved_ids));
    const candidates = parseResolvedCoins(JSON.parse(pending.candidates));
    const remainingTickers = parseStringArray(JSON.parse(pending.remaining_tickers));
    if (candidates.length === 0) return null;

    return {
      alertTypes,
      resolvedCoins: dedupeCoins(
        resolvedIds.map((id) => STABLECOIN_BY_ID.get(id) ?? { id, symbol: id, name: id }),
      ),
      ambiguousTicker: pending.ambiguous_ticker,
      candidates,
      remainingTickers,
    };
  } catch {
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

function buildNotFoundMessage(ticker: string, suggestion?: ResolvedCoin): string {
  const lines = [`Ticker "${ticker}" not found.`];
  if (suggestion) {
    lines.push(`Did you mean ${suggestion.symbol} (${suggestion.id})?`);
  }
  return escapeHtml(lines.join("\n"));
}

function buildSubscribeSuccessMessage(
  alertTypes: Set<string>,
  coins: ResolvedCoin[],
): string {
  return escapeHtml([
    `Subscribed to ${describeAlertTypes(alertTypes)}.`,
    `Coins (${coins.length}):`,
    formatCoinLines(coins),
  ].join("\n"));
}

function buildUnsubscribeSuccessMessage(coins: ResolvedCoin[]): string {
  return escapeHtml([
    `Removed ${coins.length} coin subscription${coins.length === 1 ? "" : "s"}.`,
    "Coins:",
    formatCoinLines(coins),
  ].join("\n"));
}

function describeAlertTypes(alertTypes: Set<string>): string {
  const labels: string[] = [];
  if (alertTypes.has("dews")) labels.push("DEWS");
  if (alertTypes.has("depeg")) labels.push("Depeg");
  if (alertTypes.has("safety")) labels.push("Safety");
  return labels.join(", ") || "None";
}

function formatCoinLines(coins: ResolvedCoin[]): string {
  return coins.map((coin) => `- ${coin.symbol} (${coin.id})`).join("\n") || "None";
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

async function replyToChat(
  chatId: string,
  message: string,
  botToken: string,
): Promise<void> {
  try {
    await sendToChat(chatId, message, botToken, { disableWebPagePreview: true });
  } catch {
    // Best-effort replies only; webhook processing still succeeds.
  }
}
