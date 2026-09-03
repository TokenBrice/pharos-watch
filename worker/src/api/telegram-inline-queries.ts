import { fnv1a32 } from "@shared/lib/fnv1a";
import { resolveTicker } from "../lib/telegram/alerts";
import { answerInlineQuery, type TelegramInlineQueryResultArticle } from "../lib/telegram";
import { CHAT_COMMAND_FLOOD_LIMIT, CHAT_COMMAND_FLOOD_WINDOW_SEC } from "../lib/telegram/constants";
import { recordTelegramUsageEvent } from "../lib/telegram/usage-analytics";
import { logTelegramWebhookWarning } from "./telegram-webhook-ingress-policy";
import { buildStatusMessage } from "./telegram-webhook-messages";
import type { TelegramWebhookEffectFence } from "./telegram-webhook-effect-fence";
import type { TelegramWebhookUpdate } from "./telegram-webhook-shared";
import { loadStatusForCoin } from "./telegram-webhook-status";
import { acquireTelegramCommandCooldown, recordTelegramChatCommandFlood, unixNow } from "./telegram-webhook-store";

// Inline queries are intentionally exact-match only. This prevents a typed
// prefix from fanning out into an unbounded read/result set on every keystroke.
const MAX_INLINE_STATUS_QUERY_LENGTH = 64;
const INLINE_STATUS_CACHE_TIME_SEC = 30;
const EMPTY_INLINE_STATUS_CACHE_TIME_SEC = 5;
const INLINE_STATUS_RESULT_ID_PREFIX = "status:";
const TELEGRAM_INLINE_RESULT_ID_MAX_BYTES = 64;
const INLINE_STATUS_COOLDOWN_SEC = 20;

type InlineQuery = NonNullable<TelegramWebhookUpdate["inline_query"]>;

function classifyInlineStatusQuery(rawQuery: string | undefined): {
  kind: "empty" | "invalid" | "unknown" | "ambiguous" | "resolved";
  coinId?: string;
  symbol?: string;
  name?: string;
} {
  const query = rawQuery?.trim() ?? "";
  if (!query) return { kind: "empty" };
  if (query.length > MAX_INLINE_STATUS_QUERY_LENGTH || !/^[A-Za-z0-9-]+$/.test(query)) {
    return { kind: "invalid" };
  }

  const resolution = resolveTicker(query, "tracked");
  if (resolution.status === "not_found") return { kind: "unknown" };
  if (resolution.status === "ambiguous") return { kind: "ambiguous" };
  const coin = resolution.matches[0];
  return coin ? { kind: "resolved", coinId: coin.id, symbol: coin.symbol, name: coin.name } : { kind: "unknown" };
}

function buildInlineStatusResult(input: {
  coinId: string;
  symbol: string;
  name: string;
  status: Awaited<ReturnType<typeof loadStatusForCoin>>;
}): TelegramInlineQueryResultArticle {
  return {
    type: "article",
    id: inlineStatusResultId(input.coinId),
    title: `${input.symbol} status`,
    description: `${input.name} - current Pharos peg and risk snapshot`,
    input_message_content: {
      message_text: `${buildStatusMessage(input.symbol, input.status)}\n<i>Source: Pharos cached market and risk data. Field ages are shown above.</i>`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    },
  };
}

function inlineStatusResultId(coinId: string): string {
  const candidate = `${INLINE_STATUS_RESULT_ID_PREFIX}${coinId}`;
  if (new TextEncoder().encode(candidate).length <= TELEGRAM_INLINE_RESULT_ID_MAX_BYTES) {
    return candidate;
  }

  // Registry IDs are ASCII today, but preserve the Bot API's 64-byte bound if
  // a future canonical ID grows beyond it. This id is display-independent and
  // ephemeral (Telegram only echoes it back inside the same inline session), so
  // it can ride the shared FNV-1a definition rather than fork the mixing loop.
  return `${INLINE_STATUS_RESULT_ID_PREFIX}${fnv1a32(coinId).toString(16)}`;
}

async function enforceInlineStatusReadLimit(
  db: D1Database,
  input: { actorUserId: number | undefined; coinId: string },
): Promise<"allowed" | "rate_limited" | "failure"> {
  const actorKey = input.actorUserId == null ? "unknown" : String(input.actorUserId);
  const limitKey = `inline:${actorKey}`;
  const nowSec = unixNow();

  try {
    const flood = await recordTelegramChatCommandFlood(db, {
      chatId: limitKey,
      nowSec,
      windowSec: CHAT_COMMAND_FLOOD_WINDOW_SEC,
      limit: CHAT_COMMAND_FLOOD_LIMIT,
    });
    if (!flood.allowed) return "rate_limited";
  } catch (err) {
    logTelegramWebhookWarning("inline query flood check failed", "inline-query-flood", err);
    return "failure";
  }

  try {
    const cooldown = await acquireTelegramCommandCooldown(db, {
      chatId: limitKey,
      commandKey: `/status:${input.coinId}`,
      nowSec,
      cooldownSec: INLINE_STATUS_COOLDOWN_SEC,
    });
    return cooldown.allowed ? "allowed" : "rate_limited";
  } catch (err) {
    logTelegramWebhookWarning("inline query cooldown check failed", "inline-query-cooldown", err);
    return "failure";
  }
}

/**
 * Serve a single shared, read-only status card. The raw query and Telegram
 * sender are deliberately discarded; telemetry is an aggregate outcome only.
 */
export async function handleTelegramInlineQueryUpdate(args: {
  db: D1Database;
  botToken: string;
  inlineQuery: InlineQuery;
  effectFence: TelegramWebhookEffectFence | null;
}): Promise<void> {
  const inlineQueryId = args.inlineQuery.id;
  if (!inlineQueryId) return;

  const classified = classifyInlineStatusQuery(args.inlineQuery.query);
  let results: TelegramInlineQueryResultArticle[] = [];
  let outcome: string = classified.kind;
  let cacheTimeSec = EMPTY_INLINE_STATUS_CACHE_TIME_SEC;

  if (classified.kind === "resolved" && classified.coinId && classified.symbol && classified.name) {
    const limitOutcome = await enforceInlineStatusReadLimit(args.db, {
      actorUserId: args.inlineQuery.from?.id,
      coinId: classified.coinId,
    });
    if (limitOutcome === "allowed") {
      const status = await loadStatusForCoin(args.db, classified.coinId);
      results = [
        buildInlineStatusResult({
          coinId: classified.coinId,
          symbol: classified.symbol,
          name: classified.name,
          status,
        }),
      ];
      outcome = "served";
      cacheTimeSec = INLINE_STATUS_CACHE_TIME_SEC;
    } else {
      outcome = limitOutcome;
    }
  }

  await args.effectFence?.beforeIrreversibleEffect("inline-query-answer");
  const answered = await answerInlineQuery(inlineQueryId, args.botToken, results, { cacheTimeSec });
  await recordTelegramUsageEvent(args.db, {
    eventType: "inline_query",
    sourceCategory: "inline",
    actionDetail: "status_card",
    outcome: answered ? outcome : "answer_failed",
  });
}

/** Chosen-result telemetry intentionally records no card id, query, or user. */
export async function handleTelegramChosenInlineResultUpdate(db: D1Database): Promise<void> {
  await recordTelegramUsageEvent(db, {
    eventType: "inline_result_chosen",
    sourceCategory: "inline",
    actionDetail: "status_card",
    outcome: "chosen",
  });
}

export const TELEGRAM_INLINE_STATUS_POLICY = {
  maxQueryLength: MAX_INLINE_STATUS_QUERY_LENGTH,
  maxResults: 1,
  resultCacheTimeSec: INLINE_STATUS_CACHE_TIME_SEC,
  emptyResultCacheTimeSec: EMPTY_INLINE_STATUS_CACHE_TIME_SEC,
} as const;
