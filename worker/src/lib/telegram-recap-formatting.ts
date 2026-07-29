import { formatCompactUsdShort } from "@shared/lib/format";
import { TELEGRAM_RECAP_TARGET_BODY_CHARACTERS } from "@shared/lib/telegram-recap-policy";
import { MINI_APP_PAYLOAD_NAMES } from "@shared/lib/telegram-mini-app-payloads";
import { numberValue } from "@shared/lib/type-guards";
import { escapeHtml } from "./telegram";
import { selectTelegramRecapFacts, type TelegramRecapScopedFact } from "./telegram-recap-ranking";

export interface TelegramRecapDigestLink {
  url: string;
  title?: string | null;
}

export interface TelegramRecapFormatInput {
  facts: readonly TelegramRecapScopedFact[];
  windowStartAtMs: number;
  windowEndAtMs: number;
  timezone: string;
  digest?: TelegramRecapDigestLink | null;
}

export interface TelegramRecapFormattedMessage {
  body: string;
  replyMarkup: {
    inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>>;
  };
  materialCoinCount: number;
  materialFactCount: number;
  omittedFactCount: number;
}

function recapMiniAppUrl(payload: string): string {
  return `https://pharos.watch/pharoswatchbot/app/?startapp=${payload}`;
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim().slice(0, 80);
}

function formatDuration(startedAtSec: unknown, endedAtSec: unknown, fallbackEndMs: number): string | null {
  const start = numberValue(startedAtSec);
  const end = numberValue(endedAtSec) ?? Math.floor(fallbackEndMs / 1000);
  if (start == null || end < start) return null;
  const minutes = Math.max(1, Math.round((end - start) / 60));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function factLine(fact: TelegramRecapScopedFact): string {
  const payload = fact.payload;
  switch (fact.type) {
    case "depeg.opened": {
      const direction = textValue(payload.direction) === "below" ? "below" : "above";
      return `Depeg opened ${direction} peg by ${Math.round(numberValue(payload.absDeviationBps) ?? 0)} bps.`;
    }
    case "depeg.peak_worsened":
      return `Depeg worsened to ${Math.round(numberValue(payload.absDeviationBps) ?? 0)} bps.`;
    case "depeg.resolved": {
      const duration = formatDuration(payload.startedAt, payload.endedAt, fact.ts);
      const peak = Math.round(numberValue(payload.absDeviationBps) ?? 0);
      return duration ? `Depeg resolved after ${duration}; peak deviation was ${peak} bps.` : `Depeg resolved; peak deviation was ${peak} bps.`;
    }
    case "dews.escalated":
    case "dews.deescalated":
      return `DEWS moved from ${escapeHtml(textValue(payload.prevBand) ?? "unknown")} to ${escapeHtml(textValue(payload.newBand) ?? "unknown")}.`;
    case "score.upgraded":
    case "score.downgraded":
      return `Safety grade changed from ${escapeHtml(textValue(payload.prevGrade) ?? "unknown")} to ${escapeHtml(textValue(payload.newGrade) ?? "unknown")}.`;
    case "freeze.blocked":
    case "freeze.unblocked":
    case "freeze.destroyed": {
      const action = fact.type === "freeze.blocked" ? "froze an address" : fact.type === "freeze.unblocked" ? "unfroze an address" : "destroyed funds";
      const chain = textValue(payload.chainName) ?? textValue(payload.chainId) ?? fact.chain ?? "the reported chain";
      const amount = numberValue(payload.amountUsdAtEvent);
      return `Issuer ${action} on ${escapeHtml(chain)}; ${amount == null ? "amount unavailable" : `${formatCompactUsdShort(amount)} at event`}.`;
    }
    case "mint_burn.large_mint":
    case "mint_burn.large_burn": {
      const action = fact.type === "mint_burn.large_mint" ? "mint" : "burn";
      const amount = numberValue(payload.amountUsd);
      const chain = fact.chain ?? textValue(payload.chainId);
      return `Large ${amount == null ? "amount-unavailable" : formatCompactUsdShort(amount)} ${action} recorded${chain ? ` on ${escapeHtml(chain)}` : ""}.`;
    }
    case "yield.warning_emitted": {
      const signals = Array.isArray(payload.newSignals) ? payload.newSignals : payload.signals;
      const names = Array.isArray(signals)
        ? signals.filter((value): value is string => typeof value === "string" && value.trim().length > 0).slice(0, 2).map((value) => value.slice(0, 80))
        : [];
      return names.length > 0 ? `Yield warning emitted: ${escapeHtml(names.join(", "))}.` : "Yield warning emitted.";
    }
    case "yield.pys_dropped":
      return `Yield safety score dropped from ${Math.round(numberValue(payload.prevScore) ?? 0)} to ${Math.round(numberValue(payload.newScore) ?? 0)}.`;
  }
}

function windowLabel(startAtMs: number, endAtMs: number, timezone: string): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    return `Changes from ${formatter.format(new Date(startAtMs))} to ${formatter.format(new Date(endAtMs))} (${escapeHtml(timezone)})`;
  } catch {
    return "Recent material changes";
  }
}

function validDigestUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Render exactly one HTML Telegram recap. Null means there are no material
 * facts after collapse; no fallback or all-clear message is emitted.
 */
export function formatTelegramRecap(input: TelegramRecapFormatInput): TelegramRecapFormattedMessage | null {
  const selection = selectTelegramRecapFacts(input.facts);
  if (selection.facts.length === 0) return null;

  const lines: string[] = ["<b>Your watchlist recap</b>", windowLabel(input.windowStartAtMs, input.windowEndAtMs, input.timezone)];
  const rendered: TelegramRecapScopedFact[] = [];
  const renderedCoins = new Set<string>();
  let currentCoin: string | null = null;

  for (const fact of selection.facts) {
    const section = fact.coinId === currentCoin
      ? `- ${factLine(fact)}`
      : `<b>${escapeHtml(fact.symbol)}</b>\n- ${factLine(fact)}`;
    const candidate = [...lines, section].join("\n\n");
    if (candidate.length > TELEGRAM_RECAP_TARGET_BODY_CHARACTERS) break;
    lines.push(section);
    rendered.push(fact);
    renderedCoins.add(fact.coinId);
    currentCoin = fact.coinId;
  }
  if (rendered.length === 0) return null;

  const digestUrl = validDigestUrl(input.digest?.url);
  const buildFooter = (omittedFactCount: number): string => {
    const footer = [`${renderedCoins.size} watched ${renderedCoins.size === 1 ? "asset changed" : "assets changed"}`];
    if (omittedFactCount > 0) footer.push(`+ ${omittedFactCount} more changes`);
    if (digestUrl) footer.push(`<a href="${escapeHtml(digestUrl)}">Read the full market digest</a>`);
    return footer.join("\n");
  };
  let omittedFactCount = selection.omittedFactCount + (selection.facts.length - rendered.length);
  let body = [...lines, buildFooter(omittedFactCount)].join("\n\n");
  while (body.length > TELEGRAM_RECAP_TARGET_BODY_CHARACTERS && rendered.length > 1) {
    rendered.pop();
    renderedCoins.clear();
    for (const fact of rendered) renderedCoins.add(fact.coinId);
    lines.length = 2;
    currentCoin = null;
    for (const fact of rendered) {
      lines.push(fact.coinId === currentCoin ? `- ${factLine(fact)}` : `<b>${escapeHtml(fact.symbol)}</b>\n- ${factLine(fact)}`);
      currentCoin = fact.coinId;
    }
    omittedFactCount = selection.omittedFactCount + (selection.facts.length - rendered.length);
    body = [...lines, buildFooter(omittedFactCount)].join("\n\n");
  }
  // This leaves a 500-character margin below Telegram's 4,000-character
  // message chunk limit, so no splitter is needed in the pure recap path.
  if (body.length > TELEGRAM_RECAP_TARGET_BODY_CHARACTERS) {
    throw new Error("Telegram recap formatter exceeded the one-message contract");
  }

  return {
    body,
    replyMarkup: {
      inline_keyboard: [[
        { text: "View watchlist", web_app: { url: recapMiniAppUrl(MINI_APP_PAYLOAD_NAMES.recapWatchlist) } },
        { text: "Recap settings", web_app: { url: recapMiniAppUrl(MINI_APP_PAYLOAD_NAMES.recapSettings) } },
      ]],
    },
    materialCoinCount: renderedCoins.size,
    materialFactCount: rendered.length,
    omittedFactCount,
  };
}
