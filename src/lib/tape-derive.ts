import type { TapeEvent } from "@shared/types/tape-event";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { formatCompactUsd, formatScoreTrimmed, getNetPrefix } from "@shared/lib/format";

export function utcDayKey(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

export function formatAbsoluteDate(tsMs: number): string {
  return new Date(tsMs).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export function deriveTicker(event: TapeEvent): string | null {
  if (event.coinId) {
    const symbol = TRACKED_META_BY_ID.get(event.coinId)?.symbol;
    if (symbol) return symbol;
  }
  const payload = event.payload as { symbol?: unknown; stablecoin?: unknown } | undefined;
  if (typeof payload?.symbol === "string" && payload.symbol.length > 0) return payload.symbol;
  if (typeof payload?.stablecoin === "string" && payload.stablecoin.length > 0) return payload.stablecoin;
  return null;
}

/** Event type without the optional `:suffix` disambiguator. */
export function baseEventType(type: string): string {
  return type.split(":")[0];
}

const SENTENCE_MAX_CHARS = 160;

/**
 * First sentence of an event summary, capped for one-or-two-line renderings.
 *
 * Sentence-end punctuation only counts when followed by whitespace or the end
 * of the string, so amounts like `"$20.0M burned"` are not truncated to
 * `"$20."` — the bug the /timeline card shipped with a naive `[^.!?]+[.!?]`
 * match (WS0.9c).
 */
export function firstSentence(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed.length === 0) return "";
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  const sentence = match ? match[0] : trimmed;
  return sentence.length > SENTENCE_MAX_CHARS ? `${sentence.slice(0, SENTENCE_MAX_CHARS - 3)}…` : sentence;
}

/**
 * Compact one-line delta for an event payload — `"16 → 6 · -12"`, `"$20.0M
 * burned"`, `"−45 bps"`. Returns null when the payload carries no comparable
 * numbers.
 *
 * Signs follow the shared `getNetPrefix` rule (`+` for positive only), so a
 * zero-delta transition reads `0`, not `+0`.
 */
export function describeEventDelta(event: TapeEvent): string | null {
  const payload = event.payload;
  switch (eventClassSlugOf(event.type)) {
    case "dews":
    case "psi":
    case "score":
    case "yield": {
      const prev = typeof payload?.prevScore === "number" ? payload.prevScore : null;
      const next = typeof payload?.newScore === "number" ? payload.newScore : null;
      if (prev == null || next == null) return null;
      const delta = next - prev;
      return `${formatScoreTrimmed(prev)} → ${formatScoreTrimmed(next)} · ${getNetPrefix(delta)}${formatScoreTrimmed(delta)}`;
    }
    case "mint_burn": {
      const amount = payload?.amountUsd;
      if (typeof amount !== "number" || amount <= 0) return null;
      const direction = payload?.direction;
      const verb = direction === "mint" ? "minted" : direction === "burn" ? "burned" : "moved";
      return `${formatCompactUsd(amount)} ${verb}`;
    }
    case "freeze": {
      const amount = payload?.amountUsdAtEvent;
      if (typeof amount !== "number" || amount <= 0) return null;
      return formatCompactUsd(amount);
    }
    case "depeg": {
      const abs = payload?.absDeviationBps;
      if (typeof abs !== "number") return null;
      const sign = payload?.direction === "below" ? "−" : "+";
      return `${sign}${abs} bps`;
    }
    default:
      return null;
  }
}

function eventClassSlugOf(type: string): string {
  return baseEventType(type).split(".")[0];
}
