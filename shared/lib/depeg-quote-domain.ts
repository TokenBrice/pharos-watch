import { normalizePegType } from "./peg-rates";
import type { PersistedNativePegQuote } from "../types/native-peg-quote";

export interface DepegQuoteDomain {
  source?: string;
  peg_type?: string;
  peg_reference: number;
  quote_mode?: string | null;
}

/** Historical provenance is authoritative; live native events retain reference 1. */
export function isNativePegEvent(event: DepegQuoteDomain): boolean {
  if (event.quote_mode != null) return event.quote_mode === "native-peg";
  return event.source === "live" && event.peg_reference === 1 &&
    event.peg_type != null && normalizePegType(event.peg_type) !== "peggedUSD";
}

export const PSI_NATIVE_EVIDENCE_MAX_AGE_SEC = 6 * 60 * 60;

export interface NativeEventPriceEvidence extends DepegQuoteDomain {
  started_at: number;
  start_price?: number | null;
  ended_at?: number | null;
  recovery_price?: number | null;
}

/** Event peaks have no observation clock and cannot establish a contemporaneous quote. */
export function getNativeEventPrice(
  event: NativeEventPriceEvidence,
  asOf: number,
  currentQuote?: PersistedNativePegQuote | null,
): number | null {
  let price: number | null = null;
  let observedAt = -Infinity;
  for (const [at, value] of [
    [event.started_at, event.start_price],
    [event.ended_at, event.recovery_price],
    [currentQuote?.observedAt, currentQuote?.value],
  ]) {
    if (at == null || value == null || !Number.isFinite(at) || !Number.isFinite(value) || value <= 0) continue;
    if (at <= asOf && asOf - at < PSI_NATIVE_EVIDENCE_MAX_AGE_SEC && at > observedAt) {
      price = value;
      observedAt = at;
    }
  }
  return price;
}
