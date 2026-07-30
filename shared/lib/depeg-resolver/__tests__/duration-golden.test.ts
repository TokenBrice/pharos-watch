import { describe, expect, it } from "vitest";
import durationGoldenFixtureJson from "./fixtures/duration-golden.json";
import { computeDuration, HORIZON_SECONDS } from "../duration";
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
    fragments,
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
    fragments: Array.from({ length: fragments.length / 2 }, (_, index) => ({
      offsetSec: fragments[index * 2],
      peakDeviationBps: fragments[index * 2 + 1],
    })),
  }));
}

describe("duration golden replay", () => {
  it("holds the 07-29 scored-row calibration and coverage gates", () => {
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

    const newlySuppressed = replay
      .filter(({ row, duration }) => !row.baselineSuppressed && duration.suppressed)
      .map(({ row }) => row.eventId);
    expect(newlySuppressed, "rows newly suppressed relative to the 07-29 baseline").toEqual([]);

    const scored6h = replay.filter(
      ({ duration }) => duration.horizons[0].probability != null,
    );
    const expected6h = scored6h.reduce(
      (sum, { duration }) => sum + duration.horizons[0].probability!,
      0,
    ) / scored6h.length;
    const observed6h = scored6h.filter(
      ({ row }) => row.baseline.act <= HORIZON_SECONDS["6h"],
    ).length / scored6h.length;
    const biasPercentagePoints = (expected6h - observed6h) * 100;
    expect(
      Math.abs(biasPercentagePoints),
      `6h expected-vs-observed bias was ${biasPercentagePoints.toFixed(2)}pp`,
    ).toBeLessThanOrEqual(5);

    const bandCovered = replay.filter(({ row, duration }) => (
      duration.iqrSec != null &&
      row.baseline.act >= duration.iqrSec[0] &&
      row.baseline.act <= duration.iqrSec[1]
    )).length;
    const bandCoverage = bandCovered / replay.length;
    expect(
      bandCoverage,
      `typical-range coverage was ${(bandCoverage * 100).toFixed(2)}%`,
    ).toBeGreaterThanOrEqual(0.45);
  });
});
