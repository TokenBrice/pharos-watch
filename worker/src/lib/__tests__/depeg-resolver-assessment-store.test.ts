import { afterEach, describe, expect, it, vi } from "vitest";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  type DdrDiagnosticAssessmentRow,
  type DdrDiagnosticAssessmentSnapshot,
  writeDepegResolverAssessments,
} from "../depeg-resolver-assessment-store";

const baseRow: DdrDiagnosticAssessmentRow = {
  stablecoinId: "lusd-liquity",
  symbol: "LUSD",
  name: "Liquity USD",
  pegCurrency: "USD",
  governance: "decentralized",
  status: null,
  eventId: 42,
  startedAt: 1_000_000,
  ageSec: 25 * 3600,
  direction: "below",
  peakDeviationBps: -300,
  currentDeviationBps: -250,
  resolution: {
    tier: "at_risk",
    factors: [
      {
        code: "R3_no_supply_anomaly",
        kind: "anchor",
        severity: "strong",
        label: "No supply anomaly",
      },
    ],
  },
  duration: {
    suppressed: false,
    suppressedReason: null,
    stratum: "below · moderate · robust · USD",
    medianSec: 7200,
    iqrSec: [3600, 14_400],
    ageStatus: "ordinary",
    horizons: [
      {
        horizon: "6h",
        state: "thin_support",
        probability: 0.5,
        probabilityDisplay: "35-65%",
        probabilityInterval: { lower: 0.35, upper: 0.65 },
        rawAtRisk: 12,
        uniqueCoins: 6,
        intervalClosures: 6,
        intervalNonClosures: 6,
      },
    ],
  },
  relatedContext: {
    dewsBand: null,
    dewsScore: null,
    liquidityScore: null,
    safetyGrade: null,
    safetyScore: null,
    supplyChange7dPct: null,
    supplyChange30dPct: null,
    mintSurge: null,
  },
} as DdrDiagnosticAssessmentRow;

function snapshot(
  rows: unknown[],
  overrides: Partial<DdrDiagnosticAssessmentSnapshot["_meta"]> = {},
): DdrDiagnosticAssessmentSnapshot {
  return {
    _meta: {
      dataAsOf: 2_000_000,
      modelAsOf: 2_000_000,
      computedAt: 2_000_000,
      expiresAt: 2_001_800,
      degraded: false,
      degradedReason: null,
      publicWarning: "warning",
      resolutionRubricVersion: "resolution-rubric-v1",
      durationModelVersion: "duration-landmark-v1",
      incidentGroupingVersion: "incident-group-v1",
      supportRulesVersion: "support-rules-v1",
      lineage: null,
      ...overrides,
    },
    rows,
    methodology: {
      version: DDR_METHODOLOGY_VERSION,
      versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      currentVersion: DDR_METHODOLOGY_VERSION,
      currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
      changelogPath: "/methodology/depeg-resolver-changelog/",
      asOf: 2_000_000,
      isCurrent: true,
    },
  };
}

describe("writeDepegResolverAssessments", () => {
  it("persists first, threshold, and latest checkpoints for a fresh DDR row", async () => {
    const db = mockD1([{ match: "depeg_resolver_assessments", rows: [] }]);

    const changes = await writeDepegResolverAssessments(db, snapshot([baseRow]));
    const writes = db.getHistory().filter((entry) => entry.sql.includes("depeg_resolver_assessments"));

    expect(changes).toBe(5);
    expect(writes).toHaveLength(5);
    expect(writes.map((entry) => entry.binds[10]).sort()).toEqual([
      "age_1h",
      "age_24h",
      "age_6h",
      "first",
      "latest",
    ]);
    const latest = writes.find((entry) => entry.binds[10] === "latest");
    expect(latest?.sql).toContain("ON CONFLICT(event_id, checkpoint, methodology_version) DO UPDATE");
    expect(latest?.binds[20]).toBe(7200);
    expect(latest?.binds[21]).toBe(3600);
    expect(latest?.binds[22]).toBe(14_400);
  });

  it("skips degraded and empty snapshots", async () => {
    const db = mockD1([{ match: "depeg_resolver_assessments", rows: [] }]);

    expect(await writeDepegResolverAssessments(db, snapshot([], { degraded: false }))).toBe(0);
    expect(await writeDepegResolverAssessments(db, snapshot([baseRow], { degraded: true }))).toBe(0);
    expect(db.getHistory()).toHaveLength(0);
  });

  describe("non-conforming rows", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns about dropped rows but still persists conforming ones", async () => {
      const db = mockD1([{ match: "depeg_resolver_assessments", rows: [] }]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const malformedRow = { stablecoinId: "bad", symbol: "BAD" } as unknown as DdrDiagnosticAssessmentRow;

      const changes = await writeDepegResolverAssessments(db, snapshot([baseRow, malformedRow]));

      expect(changes).toBe(5);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("Dropped 1/2 non-conforming assessment rows");
    });

    it("does not let unserializable dropped row samples abort valid writes", async () => {
      const db = mockD1([{ match: "depeg_resolver_assessments", rows: [] }]);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const malformedRow = { stablecoinId: "bad", symbol: "BAD", value: 1n };

      const changes = await writeDepegResolverAssessments(db, snapshot([malformedRow, baseRow]));
      const writes = db.getHistory().filter((entry) => entry.sql.includes("depeg_resolver_assessments"));

      expect(changes).toBe(5);
      expect(writes).toHaveLength(5);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain("Dropped 1/2 non-conforming assessment rows");
      expect(warnSpy.mock.calls[0][0]).toContain("[unserializable [object Object] keys=stablecoinId,symbol,value;");
    });
  });
});
