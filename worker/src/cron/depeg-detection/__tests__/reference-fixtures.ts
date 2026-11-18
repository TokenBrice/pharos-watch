import type { RepricingByPeg } from "../reference-policy";
import type { FxRateState } from "../../../lib/fx-rate-state";

export function referenceState(rates: Record<string, number>, observedAt: number, repriced = true): FxRateState & { repricingByPeg?: RepricingByPeg } {
  const byPeg = <T>(value: (peg: string) => T): Record<string, T> =>
    Object.fromEntries(Object.keys(rates).map((peg) => [peg, value(peg)]));
  return {
    rates,
    usableSyncAt: observedAt,
    usableAgeSec: 0,
    mode: "live",
    sourceUpdatedAtByPeg: byPeg(() => observedAt),
    sourceModeByPeg: byPeg(() => "live"),
    sourceCadenceByPeg: byPeg(() => "intraday"),
    sourceDateByPeg: {},
    sources: byPeg((peg) => peg === "peggedGOLD" ? "gold-api.com" : "openExchangeRates"),
    sourceLastSuccessAtBySource: {},
    consecutiveFallbackRuns: 0,
    metadataIdentity: "verified",
    repricingByPeg: repriced ? byPeg((peg) => ({ source: peg === "peggedGOLD" ? "gold-api.com" : "openExchangeRates", preCloseUsdPerUnit: rates[peg] * 0.999 })) : undefined,
  };
}

export const tradedPair = { kind: "traded-pair", lineage: { venue: "bitso", pair: "asset-fiat" } } as const;
