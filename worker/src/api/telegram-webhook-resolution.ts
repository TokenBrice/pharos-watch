import { escapeHtml } from "../lib/telegram";
import {
  formatDisambiguation,
  resolveTicker,
  type ResolvedCoin,
  type TickerResolutionScope,
} from "../lib/telegram-alerts";
import { buildNotFoundMessage } from "./telegram-webhook-messages";
import type {
  CoinResolution,
  PendingActionType,
} from "./telegram-webhook-shared";
import {
  PENDING_OWNERSHIP_CONFLICT_MESSAGE,
  persistPendingDisambiguation,
} from "./telegram-webhook-store";
import { dedupeCoins } from "./telegram-webhook-parsing";

export function resolveCoinTargets(
  tickers: string[],
  initialCoins: ResolvedCoin[] = [],
  resolutionScope: TickerResolutionScope = "subscribable",
): CoinResolution {
  const coins = dedupeCoins(initialCoins);
  const seenIds = new Set(coins.map((coin) => coin.id));

  for (let index = 0; index < tickers.length; index += 1) {
    const ticker = tickers[index];
    const match = resolveTicker(ticker, resolutionScope);

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

// Result of onComplete. The `gated` variant means the handler has already sent
// its own reply (e.g. a bulk-confirm prompt), so the flow must not send another.
export type CoinResolutionCompletion =
  | { kind: "gated" }
  | { kind: "message"; text: string; replyMarkup?: unknown };

interface RunCoinResolutionFlowOptions<TActionPayload extends object> {
  db: D1Database;
  chatId: string;
  tickers: string[];
  actionType: PendingActionType;
  actionPayload: TActionPayload;
  initiatorUserId: string | null;
  reply: (message: string, options?: { replyMarkup?: unknown }) => Promise<void>;
  replyWithMarkup?: (message: string, options: { replyMarkup?: unknown }) => Promise<void>;
  onComplete: (
    coins: ResolvedCoin[],
    options: { clearPending: boolean },
  ) => Promise<CoinResolutionCompletion>;
  alertTypes?: Set<string>;
  initialCoins?: ResolvedCoin[];
  clearPendingOnTerminal?: boolean;
  resolutionScope?: TickerResolutionScope;
  persistAmbiguous?: (resolution: Extract<CoinResolution, { kind: "ambiguous" }>) => Promise<boolean>;
}

function buildDisambiguationKeyboard(candidates: readonly ResolvedCoin[]): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} | null {
  if (candidates.length === 0 || candidates.length > 5) return null;
  return {
    inline_keyboard: candidates.map((coin, index) => [
      { text: `${index + 1}. ${coin.symbol}`, callback_data: `select:${index + 1}` },
    ]),
  };
}

export async function runCoinResolutionFlow<TActionPayload extends object>({
  db,
  chatId,
  tickers,
  actionType,
  actionPayload,
  initiatorUserId,
  reply,
  replyWithMarkup,
  onComplete,
  alertTypes,
  initialCoins = [],
  clearPendingOnTerminal = false,
  resolutionScope = "subscribable",
  persistAmbiguous,
}: RunCoinResolutionFlowOptions<TActionPayload>): Promise<void> {
  const resolution = resolveCoinTargets(tickers, initialCoins, resolutionScope);

  if (resolution.kind === "not_found") {
    await reply(buildNotFoundMessage(resolution.ticker, resolution.suggestion));
    return;
  }

  if (resolution.kind === "ambiguous") {
    const persisted = persistAmbiguous
      ? await persistAmbiguous(resolution)
      : await persistPendingDisambiguation(db, {
      chatId,
      actionType,
      actionPayload,
      alertTypes,
      resolvedCoins: resolution.coins,
      ambiguousTicker: resolution.ticker,
      candidates: resolution.candidates,
      remainingTickers: resolution.remainingTickers,
      initiatorUserId,
        });
    if (!persisted) {
      await reply(PENDING_OWNERSHIP_CONFLICT_MESSAGE);
      return;
    }
    const message = escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates));
    const replyMarkup = buildDisambiguationKeyboard(resolution.candidates);
    if (replyMarkup && replyWithMarkup) {
      await replyWithMarkup(message, { replyMarkup });
      return;
    }
    await reply(message);
    return;
  }

  const completion = await onComplete(resolution.coins, {
    clearPending: clearPendingOnTerminal,
  });
  if (completion.kind === "gated") return;
  await reply(completion.text, completion.replyMarkup ? { replyMarkup: completion.replyMarkup } : undefined);
}
