import type { DepegEvent, DepegPendingIncident, StressSignalEntry } from "@shared/types";

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

export function makePendingIncident(overrides: Partial<DepegPendingIncident> = {}): DepegPendingIncident {
  const firstSeenAt = overrides.firstSeenAt ?? 1_700_000_000;
  return {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    direction: "below",
    firstSeenAt,
    lastSeenAt: firstSeenAt + 900,
    firstSeenBps: -120,
    lastSeenBps: -120,
    peakSeenBps: -120,
    reason: "confirmation-required",
    ageSec: 900,
    expiresAt: firstSeenAt + 2700,
    availableConfirmationCategories: ["cex", "dex"],
    missingConfirmationCategories: ["native"],
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
