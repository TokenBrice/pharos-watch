import { afterEach, describe, expect, it, vi } from "vitest";
import { DDR_METHODOLOGY_VERSION, DDR_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/depeg-resolver";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
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

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});

describe("writeDepegResolverAssessments", () => {
  it("covers each persisted column once and updates exactly the mutable latest columns", async () => {
    const { db, sqlite } = fixtures.open();
    const prepare = vi.spyOn(db, "prepare");
    await writeDepegResolverAssessments(db, snapshot([baseRow]));
    const sql = prepare.mock.calls.map(([query]) => query).find((query) => query.includes("ON CONFLICT"))!;
    const columns = sql.match(/\(([^)]+)\)\s+VALUES/)![1].split(",").map((column) => column.trim());
    const schemaColumns = sqlite.prepare("PRAGMA table_info(depeg_resolver_assessments)").all()
      .map((row) => String(row.name)).filter((column) => column !== "id");
    expect(new Set(columns).size).toBe(columns.length);
    expect(columns).toEqual(schemaColumns);
    expect(sql.match(/\?/g)).toHaveLength(schemaColumns.length);
    const assignments = sql.split("DO UPDATE SET")[1].trim().split(/,\s*/);
    expect(assignments).toEqual(schemaColumns
      .filter((column) => !["event_id", "checkpoint", "methodology_version", "created_at"].includes(column))
      .map((column) => `${column} = excluded.${column}`));
  });

  it("persists threshold checkpoints immutably while updating latest median and IQR values", async () => {
    const { db, sqlite } = fixtures.open();
    const clock = vi.spyOn(Date, "now").mockReturnValue(2_000_000_000);
    const rowsForEvent = sqlite.prepare(
      "SELECT * FROM depeg_resolver_assessments WHERE event_id = ? AND methodology_version = ? ORDER BY checkpoint",
    );

    expect(await writeDepegResolverAssessments(db, snapshot([baseRow]))).toBe(5);
    const firstRows = rowsForEvent.all(baseRow.eventId, DDR_METHODOLOGY_VERSION);
    expect(firstRows.map((row) => row.checkpoint)).toEqual([
      "age_1h", "age_24h", "age_6h", "first", "latest",
    ]);
    for (const row of firstRows) {
      expect(row).toMatchObject({
        event_id: baseRow.eventId,
        stablecoin_id: baseRow.stablecoinId,
        symbol: baseRow.symbol,
        name: baseRow.name,
        peg_currency: baseRow.pegCurrency,
        governance: baseRow.governance,
        direction: baseRow.direction,
        started_at: baseRow.startedAt,
        assessed_at: 2_000_000,
        event_age_sec: 25 * 3600,
        checkpoint: row.checkpoint,
        methodology_version: DDR_METHODOLOGY_VERSION,
        methodology_version_label: DDR_METHODOLOGY_VERSION_LABEL,
        resolution_rubric_version: "resolution-rubric-v1",
        duration_model_version: "duration-landmark-v1",
        incident_grouping_version: "incident-group-v1",
        support_rules_version: "support-rules-v1",
        resolution_tier: "at_risk",
        duration_suppressed: 0,
        duration_suppressed_reason: null,
        median_remaining_sec: 7200,
        iqr_low_remaining_sec: 3600,
        iqr_high_remaining_sec: 14_400,
        stratum: baseRow.duration.stratum,
        horizons_json: JSON.stringify(baseRow.duration.horizons),
        factors_json: JSON.stringify(baseRow.resolution.factors),
        row_json: JSON.stringify(baseRow),
        created_at: 2_000_000,
        updated_at: 2_000_000,
      });
    }

    const updatedRow: DdrDiagnosticAssessmentRow = {
      ...baseRow,
      ageSec: 26 * 3600,
      duration: { ...baseRow.duration, medianSec: 1111, iqrSec: [333, 2222] },
    };
    clock.mockReturnValue(2_003_600_000);
    expect(await writeDepegResolverAssessments(
      db, snapshot([updatedRow], { computedAt: 2_003_600 }),
    )).toBe(1);

    const secondRows = rowsForEvent.all(baseRow.eventId, DDR_METHODOLOGY_VERSION);
    expect(secondRows.filter((row) => row.checkpoint !== "latest"))
      .toEqual(firstRows.filter((row) => row.checkpoint !== "latest"));
    expect(secondRows.find((row) => row.checkpoint === "latest")).toMatchObject({
      assessed_at: 2_003_600,
      event_age_sec: 26 * 3600,
      median_remaining_sec: 1111,
      iqr_low_remaining_sec: 333,
      iqr_high_remaining_sec: 2222,
      row_json: JSON.stringify(updatedRow),
      created_at: 2_000_000,
      updated_at: 2_003_600,
    });
  });

  it("skips degraded and empty snapshots", async () => {
    const db = mockD1([{ match: "depeg_resolver_assessments", rows: [] }]);

    expect(await writeDepegResolverAssessments(db, snapshot([], { degraded: false }))).toBe(0);
    expect(await writeDepegResolverAssessments(db, snapshot([baseRow], { degraded: true }))).toBe(0);
    expect(db.getHistory()).toHaveLength(0);
  });

  it.each([
    ["malformed", { stablecoinId: "bad", symbol: "BAD" }],
    ["unserializable", { stablecoinId: "bad", symbol: "BAD", value: 1n }],
  ])("quarantines %s rows without aborting conforming checkpoint writes", async (_kind, malformedRow) => {
    const { db, sqlite } = fixtures.open();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await writeDepegResolverAssessments(db, snapshot([malformedRow, baseRow]))).toBe(5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare(
      "SELECT checkpoint, event_id, stablecoin_id FROM depeg_resolver_assessments ORDER BY checkpoint",
    ).all()).toEqual(
      ["age_1h", "age_24h", "age_6h", "first", "latest"].map((checkpoint) => ({
        checkpoint, event_id: baseRow.eventId, stablecoin_id: baseRow.stablecoinId,
      })),
    );
  });
});
