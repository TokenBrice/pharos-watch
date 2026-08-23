import type { DdrRow } from "@shared/types/depeg-resolver";
import type { DdrCanonicalIncident } from "../depeg-resolver-v2-contracts";

interface ResolverRowOptions {
  defaultAgeSec?: number;
  factorLabel?: string;
  name?: string;
  nowSec?: number;
  stablecoinId?: string;
  symbol?: string;
}

export function makeDdrResolverRow(
  overrides: Partial<DdrRow> = {},
  options: ResolverRowOptions = {},
): DdrRow {
  const nowSec = options.nowSec ?? 1_779_984_600;
  const startedAt = overrides.startedAt ?? nowSec - (options.defaultAgeSec ?? 6 * 3600);
  return {
    stablecoinId: options.stablecoinId ?? "projection-test",
    symbol: options.symbol ?? "PRJ",
    name: options.name ?? "Projection Test",
    pegCurrency: "USD",
    governance: "decentralized",
    status: "active",
    eventId: 42,
    startedAt,
    ageSec: overrides.ageSec ?? nowSec - startedAt,
    direction: "below",
    peakDeviationBps: -250,
    currentDeviationBps: -180,
    resolution: {
      tier: "recovery_likely",
      factors: [
        {
          code: "R2_hard_collateral_redemption",
          kind: "anchor",
          severity: "strong",
          label: options.factorLabel ?? "Fixture has a hard collateral recovery anchor",
        },
      ],
    },
    duration: {
      suppressed: false,
      suppressedReason: null,
      stratum: "below - moderate - robust - USD",
      medianSec: 3600,
      iqrSec: [1800, 7200],
      ageStatus: "ordinary",
      horizons: [
        {
          horizon: "6h",
          state: "benchmarked",
          probability: 0.75,
          probabilityDisplay: "70-80%",
          probabilityInterval: { lower: 0.7, upper: 0.8 },
          rawAtRisk: 20,
          uniqueCoins: 12,
          intervalClosures: 15,
          intervalNonClosures: 5,
        },
      ],
    },
    relatedContext: {
      dewsBand: "WATCH",
      dewsScore: 22,
      liquidityScore: 88,
      safetyGrade: "A",
      safetyScore: 91,
      supplyChange7dPct: 0,
      supplyChange30dPct: 0,
      mintSurge: false,
    },
    ...overrides,
  };
}

export function makeDdrCanonicalIncident(
  row: DdrRow,
  overrides: Partial<DdrCanonicalIncident> = {},
): DdrCanonicalIncident {
  return {
    incidentKey: `ddr2:projection-${row.eventId}`,
    eventId: row.eventId,
    currentEventId: row.eventId,
    stablecoinId: row.stablecoinId,
    pegCurrency: row.pegCurrency,
    direction: row.direction,
    startedAt: row.startedAt,
    eligibleAt: row.startedAt + 24 * 3600,
    policyUniverseIncluded: true,
    rolloutActiveAtEnablement: true,
    confirmedAt: null,
    lockState: null,
    ...overrides,
  };
}
