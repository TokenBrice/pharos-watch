import { describe, expect, it } from "vitest";
import durationGoldenFixtureJson from "./fixtures/duration-golden.json";
import { computeDuration } from "../duration";
import { quarantinedCoins, type DdrIncident } from "../incident-groups";
import { depthBucket, type DdrStratumKey } from "../strata";

interface ScoredDurationBaseline {
  coin: string;
  ageSec: number;
  act: number;
}

interface GoldenRow {
  eventId: number;
  publicPredictionId: number;
  sourcePeakDeviationBps: number;
  active: DdrStratumKey;
  baselineSuppressed: boolean;
  baseline: ScoredDurationBaseline;
}

type IncidentTuple = [
  coinIndex: number,
  direction: 0 | 1,
  peakDeviationBps: number,
  currency: 0 | 1,
  structural: 0 | 1,
  startedAt: number,
  endedAt: number,
  recovered: 0 | 1,
  fragments: number[],
];

interface DurationGoldenFixture {
  schemaVersion: number;
  baselineComputedAt: number;
  sourceCounts: {
    scoredRows: number;
    rawEvents: number;
    groupedIncidents: number;
  };
  quarantinedCoinIds: string[];
  rows: GoldenRow[];
  coinIds: string[];
  incidents: IncidentTuple[];
}

const fixture = durationGoldenFixtureJson as unknown as DurationGoldenFixture;

function decodeIncidents(): DdrIncident[] {
  return fixture.incidents.map(([
    coinIndex,
    direction,
    peakDeviationBps,
    currency,
    structural,
    startedAt,
    endedAt,
    recovered,
    // Archived fragment offsets paired with final peaks have no observation
    // provenance. Retain the archive, but never admit them as timed severity.
  ]) => ({
    stablecoinId: fixture.coinIds[coinIndex],
    direction: direction === 1 ? "above" : "below",
    peakDeviationBps,
    depth: depthBucket(peakDeviationBps),
    currency: currency === 1 ? "non-USD" : "USD",
    structural: structural === 1 ? "robust" : "fragile",
    startedAt,
    endedAt,
    durationSec: endedAt - startedAt,
    recovered: recovered === 1,
    fragments: [],
  }));
}

describe("duration golden replay", () => {
  it("keeps the 07-29 archive unsupported rather than blessing untimed peaks as calibration evidence", () => {
    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.sourceCounts).toEqual({
      scoredRows: 39,
      rawEvents: 21_244,
      groupedIncidents: 8_950,
    });
    expect(fixture.rows).toHaveLength(39);
    expect(new Set(fixture.rows.map((row) => row.eventId))).toHaveLength(39);
    for (const row of fixture.rows) {
      expect(row.active.depth).toBe(depthBucket(row.sourcePeakDeviationBps));
    }

    const incidents = decodeIncidents();
    const quarantined = quarantinedCoins(incidents);
    expect([...quarantined].sort()).toEqual(fixture.quarantinedCoinIds);
    const replay = fixture.rows.map((row) => ({
      row,
      duration: computeDuration(row.active, row.baseline.ageSec, incidents, quarantined),
    }));

    for (const { duration } of replay) {
      expect(duration.suppressed).toBe(true);
      expect(duration.suppressedReason).toBe("insufficient_support");
      expect(duration.medianSec).toBeNull();
      expect(duration.iqrSec).toBeNull();
      expect(duration.horizons.every((cell) => cell.rawAtRisk === 0 && cell.probability == null)).toBe(true);
    }
  });
});
