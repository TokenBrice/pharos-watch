import type { ConsolidatedAlerts } from "../telegram/alerts";

export function emptyConsolidatedAlerts(overrides: Partial<ConsolidatedAlerts> = {}): ConsolidatedAlerts {
  return {
    dews: [], depegTriggered: [], depegResolved: [], depegWorsening: [],
    safety: [], launch: [], reserve: [], freeze: [],
    ...overrides,
  };
}

export function singleCoinAlerts(stablecoinId: string): ConsolidatedAlerts {
  return emptyConsolidatedAlerts({
    dews: [{ stablecoinId, symbol: "USDC", oldBand: "CALM", newBand: "ALERT", score: 42, topSignals: [] }],
  });
}
