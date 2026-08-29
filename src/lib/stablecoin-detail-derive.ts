import { deriveDepegSignal } from "@shared/lib/depeg-signals";

export function deriveSupplyFromMarketCap(
  marketCapUsd: number | null | undefined,
  priceUsd: number | null | undefined,
): number | null {
  if (typeof marketCapUsd !== "number" || marketCapUsd <= 0) return null;
  if (typeof priceUsd !== "number" || priceUsd <= 0) return null;
  return marketCapUsd / priceUsd;
}

/** Local preview only; authoritative current deviation comes from peg-summary. */
export function deriveIndicativeDeviationBps(
  priceUsd: number | null | undefined,
  pegReference: number | null,
): number | null {
  if (priceUsd == null || pegReference == null) return null;
  return deriveDepegSignal(priceUsd, pegReference)?.bps ?? null;
}

export function deriveGaugeDeviationBps(
  deviationBps: number | null,
  isNavToken: boolean,
): number {
  return isNavToken ? 0 : deviationBps ?? 0;
}
