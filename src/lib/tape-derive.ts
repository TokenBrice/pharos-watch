import type { TapeEvent } from "@shared/types/tape-event";
import { CLIENT_TRACKED_META_BY_ID as TRACKED_META_BY_ID } from "@shared/lib/stablecoins/client-registry";
import { formatCompactUsd, formatScoreTrimmed, formatUtcDateOnly, getNetPrefix } from "@shared/lib/format";
import { CHAIN_META } from "@shared/types/chain-identity";
import { selectInvestmentWarningSignals } from "@shared/lib/yield-warning-signals";
import { formatYieldWarningSignal } from "@/lib/yield-constants";

export function utcDayKey(tsMs: number): string {
  return formatUtcDateOnly(new Date(tsMs));
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

/**
 * One-line display title for compact event surfaces. Stored titles are written
 * by the Worker projectors and can carry machine vocabulary (yield warning keys,
 * bare chain ids); this rebuilds those two families from structured fields so
 * readers see plain language. Other titles pass through unchanged.
 */
export function formatTapeEventTitle(event: TapeEvent): string {
  const type = baseEventType(event.type);
  if (type === "yield.warning_emitted") {
    const signals = event.payload?.newSignals;
    const ticker = deriveTicker(event);
    if (ticker && Array.isArray(signals) && signals.length > 0 && signals.every((s) => typeof s === "string")) {
      return `${ticker} yield warning: ${signals.map(formatYieldWarningSignal).join(", ")}`;
    }
  }
  if ((type === "mint_burn.large_mint" || type === "mint_burn.large_burn") && event.chain) {
    const chainName = CHAIN_META[event.chain]?.name;
    const suffix = ` · ${event.chain}`;
    if (chainName && event.title.endsWith(suffix)) {
      return `${event.title.slice(0, -suffix.length)} · ${chainName}`;
    }
  }
  return event.title;
}

/**
 * Display summary, with the same plain-language rewrite as
 * `formatTapeEventTitle`: the stored yield-warning key list `(a, b)` becomes
 * its labels and a trailing bare chain id becomes the chain name. Stored
 * summaries stay untouched; unrecognised shapes pass through.
 */
export function formatTapeEventSummary(event: TapeEvent): string {
  const summary = event.summary;
  const type = baseEventType(event.type);
  if (type === "yield.warning_emitted") {
    const signals = event.payload?.newSignals;
    if (Array.isArray(signals) && signals.length > 0 && signals.every((s) => typeof s === "string")) {
      return summary.replace(`(${signals.join(", ")})`, `(${signals.map(formatYieldWarningSignal).join(", ")})`);
    }
  }
  if ((type === "mint_burn.large_mint" || type === "mint_burn.large_burn") && event.chain) {
    const chainName = CHAIN_META[event.chain]?.name;
    const suffix = ` on ${event.chain}.`;
    if (chainName && summary.endsWith(suffix)) {
      return `${summary.slice(0, -suffix.length)} on ${chainName}.`;
    }
  }
  return summary;
}

/**
 * Reader projection for yield warning events (ADR-42). Operational advisories
 * (aging, staleness, benchmark degradation) are not investment warnings, so an
 * event whose new signals are all operational is omitted (null) and a mixed one
 * is rebuilt from its investment signals with identity, cursor and timestamps
 * preserved. Missing or malformed structured signals get neutral unavailable
 * detail, never the stored advisory text. Raw events are never mutated.
 */
export function projectTapeEventForReader(event: TapeEvent): TapeEvent | null {
  if (baseEventType(event.type) !== "yield.warning_emitted") return event;
  const payload = event.payload as Record<string, unknown> | undefined;
  const newSignals = payload?.newSignals;
  if (!Array.isArray(newSignals) || newSignals.length === 0 || !newSignals.every((s) => typeof s === "string")) {
    const ticker = deriveTicker(event);
    return { ...event, title: `${ticker ?? "Yield"} yield warning`, summary: "Signal details unavailable." };
  }
  const kept = selectInvestmentWarningSignals(newSignals as string[]);
  if (kept.length === newSignals.length) return event;
  if (kept.length === 0) return null;
  const rawLabel = (newSignals as string[]).join(", ");
  const keptLabel = kept.join(", ");
  const single = kept.length === 1;
  const keptCurrent = Array.isArray(payload?.signals) ? selectInvestmentWarningSignals(payload.signals as string[]) : payload?.signals;
  const keptPrevious = Array.isArray(payload?.prevSignals) ? selectInvestmentWarningSignals(payload.prevSignals as string[]) : payload?.prevSignals;
  return {
    ...event,
    title: event.title.replace(rawLabel, keptLabel),
    summary: event.summary
      .replace(`(${rawLabel})`, `(${keptLabel})`)
      .replace(/ signals? \(/, single ? " signal (" : " signals ("),
    payload: { ...payload, signals: keptCurrent, prevSignals: keptPrevious, newSignals: kept },
  };
}

export function projectTapeEventsForReader(events: readonly TapeEvent[]): TapeEvent[] {
  const out: TapeEvent[] = [];
  for (const event of events) {
    const projected = projectTapeEventForReader(event);
    if (projected) out.push(projected);
  }
  return out;
}
