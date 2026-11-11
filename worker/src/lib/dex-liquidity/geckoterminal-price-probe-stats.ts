export interface GtProbeTransportStats {
  attempted: number;
  priced: number;
  lookupMisses: number;
  upstreamErrors: number;
}

export interface GtProbeStats {
  probed: number;
  pricesObtained: number;
  divergences500bps: number;
  skippedLowTvl: number;
  lookupMisses: number;
  upstreamErrors: number;
  publicFallbacks: number;
  budgetExhausted: boolean;
  budgetSkipped: number;
  inlineDisabled?: boolean;
  isolationReason?: "worker-memory-boundary" | null;
  transports: {
    coingeckoOnchain: GtProbeTransportStats;
    geckoTerminalPublic: GtProbeTransportStats;
  };
}

export function createEmptyGtProbeStats(): GtProbeStats {
  return {
    probed: 0,
    pricesObtained: 0,
    divergences500bps: 0,
    skippedLowTvl: 0,
    lookupMisses: 0,
    upstreamErrors: 0,
    publicFallbacks: 0,
    budgetExhausted: false,
    budgetSkipped: 0,
    transports: {
      coingeckoOnchain: {
        attempted: 0,
        priced: 0,
        lookupMisses: 0,
        upstreamErrors: 0,
      },
      geckoTerminalPublic: {
        attempted: 0,
        priced: 0,
        lookupMisses: 0,
        upstreamErrors: 0,
      },
    },
  };
}
