import type { DepegEvent } from "../types/market";

export type TestPegEvent = DepegEvent;

export function makePegEvent(
  overrides: Partial<TestPegEvent> & Pick<TestPegEvent, "startedAt" | "peakDeviationBps">,
): TestPegEvent {
  return {
    id: 1,
    stablecoinId: "test-coin",
    symbol: "TEST",
    pegType: "peggedUSD",
    direction: overrides.peakDeviationBps < 0 ? "below" : "above",
    endedAt: null,
    startPrice: 1,
    peakPrice: null,
    recoveryPrice: null,
    pegReference: 1,
    source: "live",
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
    provenance: null,
    ...overrides,
  };
}
