import type { TapeEvent } from "@shared/types/tape-event";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

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
