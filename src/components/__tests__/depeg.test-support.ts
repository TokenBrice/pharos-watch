import type { DepegEvent, StressSignalEntry } from "@shared/types";

export function makeEvent(overrides: Partial<DepegEvent> = {}): DepegEvent {
  return {
    id: 1,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -150,
    startedAt: 1_700_000_000,
    endedAt: 1_700_086_400,
    startPrice: 0.985,
    peakPrice: 0.982,
    recoveryPrice: 0.999,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
    ...overrides,
  };
}

export function makeDews(overrides: Partial<StressSignalEntry> = {}): StressSignalEntry {
  return {
    score: 0,
    band: "CALM",
    signals: {},
    computedAt: 0,
    methodologyVersion: "v1",
    ...overrides,
  };
}
