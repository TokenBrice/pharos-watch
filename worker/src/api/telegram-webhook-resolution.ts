import { escapeHtml } from "../lib/telegram";
import {
  formatDisambiguation,
  resolveTicker,
  type ResolvedCoin,
} from "../lib/telegram-alerts";
import { buildNotFoundMessage } from "./telegram-webhook-messages";
import type {
  CoinResolution,
  PendingActionType,
} from "./telegram-webhook-shared";
import {
  clearPendingDisambiguation,
  persistPendingDisambiguation,
} from "./telegram-webhook-store";
import { dedupeCoins } from "./telegram-webhook-parsing";

export function resolveCoinTargets(
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

interface RunCoinResolutionFlowOptions<TActionPayload extends Record<string, unknown>> {
  db: D1Database;
  chatId: string;
  tickers: string[];
  actionType: PendingActionType;
  actionPayload: TActionPayload;
  reply: (message: string) => Promise<void>;
  onComplete: (
    coins: ResolvedCoin[],
    options: { clearPending: boolean },
  ) => Promise<string>;
  alertTypes?: Set<string>;
  initialCoins?: ResolvedCoin[];
  clearPendingOnTerminal?: boolean;
}

export async function runCoinResolutionFlow<TActionPayload extends Record<string, unknown>>({
  db,
  chatId,
  tickers,
  actionType,
  actionPayload,
  reply,
  onComplete,
  alertTypes,
  initialCoins = [],
  clearPendingOnTerminal = false,
}: RunCoinResolutionFlowOptions<TActionPayload>): Promise<void> {
  const resolution = resolveCoinTargets(tickers, initialCoins);

  if (resolution.kind === "not_found") {
    if (clearPendingOnTerminal) {
      await clearPendingDisambiguation(db, chatId);
    }
    await reply(buildNotFoundMessage(resolution.ticker, resolution.suggestion));
    return;
  }

  if (resolution.kind === "ambiguous") {
    await persistPendingDisambiguation(db, {
      chatId,
      actionType,
      actionPayload,
      alertTypes,
      resolvedCoins: resolution.coins,
      ambiguousTicker: resolution.ticker,
      candidates: resolution.candidates,
      remainingTickers: resolution.remainingTickers,
    });
    await reply(
      escapeHtml(formatDisambiguation(resolution.ticker, resolution.candidates)),
    );
    return;
  }

  const message = await onComplete(resolution.coins, {
    clearPending: clearPendingOnTerminal,
  });
  await reply(message);
}
