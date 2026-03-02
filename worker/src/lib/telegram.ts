import { BACKING_BADGE_STYLES, GOVERNANCE_BADGE_STYLES } from "../../../src/lib/classification";
import type { BackingType, GovernanceType } from "../../../src/lib/types";

export interface TelegramCreds {
  botToken: string;
  chatId: string;
}

/** Escape HTML special characters for Telegram HTML parse mode. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Build the full Telegram message for a digest. */
export function buildTelegramMessage(title: string, extended: string, date: string): string {
  return `<b>${escapeHtml(title)}</b>\n\n${escapeHtml(extended)}\n\n<a href="https://pharos.watch/digest/${date}">Read on Pharos →</a>`;
}

/** Post a raw text message to a Telegram channel. Throws on API error. */
async function postTelegramMessage(text: string, creds: TelegramCreds): Promise<void> {
  const url = `https://api.telegram.org/bot${creds.botToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: creds.chatId,
      text,
      parse_mode: "HTML",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API ${res.status}: ${body.slice(0, 300)}`);
  }
}

/**
 * Format and post a digest to the Telegram channel.
 * The caller is responsible for catching errors (this is non-fatal).
 */
export async function postDigestToTelegram(
  title: string,
  extended: string,
  date: string,
  creds: TelegramCreds,
): Promise<void> {
  const text = buildTelegramMessage(title, extended, date);
  await postTelegramMessage(text, creds);
  console.log(`[telegram] Posted digest (${text.length} chars)`);
}

// ---------------------------------------------------------------------------
// DEWS alert helpers
// ---------------------------------------------------------------------------

const SIGNAL_LABELS: Record<string, string> = {
  supply: "Supply Velocity",
  pool: "Pool Balance Drift",
  liq: "Liquidity Erosion",
  price: "Price Confidence",
  diverg: "Cross-source Divergence",
  black: "Blacklist Activity",
  flow: "Mint/Burn Flow",
  yield: "Yield Anomaly",
};

export interface DewsAlertParams {
  stablecoinId: string;
  name: string;
  symbol: string;
  backing: string;
  governance: string;
  mcapUsd: number;
  price: number | null;
  score: number;
  band: string;
  prevBand: string;
  topSignals: { label: string; value: number }[];
}

/** Extract the top N available signals above a score threshold, sorted descending. */
export function extractTopSignals(
  signals: Record<string, { value: number; available: boolean }>,
  maxCount = 3,
  threshold = 30,
): { label: string; value: number }[] {
  return Object.entries(signals)
    .filter(([, s]) => s.available && s.value >= threshold)
    .sort(([, a], [, b]) => b.value - a.value)
    .slice(0, maxCount)
    .map(([key, s]) => ({ label: SIGNAL_LABELS[key] ?? key, value: Math.round(s.value) }));
}

/** Build the HTML Telegram message for a DEWS band-entry alert. */
export function buildDewsAlertMessage(params: DewsAlertParams): string {
  const { stablecoinId, name, symbol, backing, governance, mcapUsd, price, score, band, prevBand, topSignals } = params;
  const emoji = band === "DANGER" ? "🚨" : "⚠️";
  const backingLabel = BACKING_BADGE_STYLES[backing as BackingType]?.label ?? backing;
  const governanceLabel = GOVERNANCE_BADGE_STYLES[governance as GovernanceType]?.label ?? governance;
  const mcapStr = mcapUsd >= 1e9
    ? `$${(mcapUsd / 1e9).toFixed(1)}B`
    : `$${Math.round(mcapUsd / 1e6)}M`;
  const priceStr = price != null ? ` | Price: $${price.toFixed(4)}` : "";
  const signalLines = topSignals.length > 0
    ? `\n\n<b>Top stress signals:</b>\n${topSignals.map(s => `• ${escapeHtml(s.label)}: ${s.value}`).join("\n")}`
    : "";

  return (
    `${emoji} <b>${band}: ${escapeHtml(symbol)}</b>\n\n` +
    `<b>${escapeHtml(name)}</b> (${escapeHtml(backingLabel)}, ${escapeHtml(governanceLabel)}) has entered the DEWS <b>${band}</b> band.\n` +
    `Score: <b>${score}</b>/100 — up from ${escapeHtml(prevBand)}\n` +
    `Market cap: ${mcapStr}${priceStr}` +
    signalLines +
    `\n\n<a href="https://pharos.watch/stablecoin/${escapeHtml(stablecoinId)}">View full analysis →</a>`
  );
}

/**
 * Format and post a DEWS band-entry alert to the Telegram channel.
 * The caller is responsible for catching errors (this is non-fatal).
 */
export async function postDewsAlert(
  params: DewsAlertParams,
  creds: TelegramCreds,
): Promise<void> {
  const text = buildDewsAlertMessage(params);
  await postTelegramMessage(text, creds);
  console.log(`[telegram] Posted DEWS alert: ${params.symbol} entered ${params.band} (score: ${params.score})`);
}
