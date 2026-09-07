import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { loadPredictionErrata, type LoadPredictionErrataFilters } from "../depeg-resolver-errata-store";

const ERRATUM_ROW = {
  id: 9,
  public_prediction_id: 77,
  incident_key: "ddr:usdc:below",
  event_id: 42,
  assessment_id: 101,
  reason: "input_corruption",
  operator_note: "invalid source payload",
  replacement_assessment_id: 102,
  replacement_row_hash: "b".repeat(64),
  row_hash_before: "a".repeat(64),
  created_at: 1_800_000_000,
  created_by: "operator",
};

function errataDb() {
  return mockD1([{ match: "FROM depeg_resolver_prediction_errata", rows: [ERRATUM_ROW] }]);
}

describe("loadPredictionErrata", () => {
  it("maps the durable row contract for an unfiltered read", async () => {
    const db = errataDb();

    await expect(loadPredictionErrata(db)).resolves.toEqual([{
      id: 9,
      publicPredictionId: 77,
      incidentKey: "ddr:usdc:below",
      eventId: 42,
      assessmentId: 101,
      reason: "input_corruption",
      operatorNote: "invalid source payload",
      replacementAssessmentId: 102,
      replacementRowHash: "b".repeat(64),
      rowHashBefore: "a".repeat(64),
      createdAt: 1_800_000_000,
      createdBy: "operator",
    }]);
    expect(db.getHistory()[0]?.sql).not.toContain("WHERE");
  });

  it.each([
    ["public prediction", { publicPredictionIds: [77, 77, 78] }, "public_prediction_id", [77, 78]],
    ["incident", { incidentKeys: ["ddr:usdc:below", "ddr:usdc:below"] }, "incident_key", ["ddr:usdc:below"]],
    ["event", { eventIds: [42, 43, 42] }, "event_id", [42, 43]],
  ] as const)("deduplicates the %s filter before binding", async (_label, filters, column, binds) => {
    const db = errataDb();

    await loadPredictionErrata(db, filters as LoadPredictionErrataFilters);

    expect(db.getHistory()[0]?.sql).toContain(`WHERE ${column} IN`);
    expect(db.getHistory()[0]?.binds).toEqual(binds);
  });

  it.each([
    { publicPredictionIds: [] },
    { incidentKeys: [] },
    { eventIds: [] },
  ] as LoadPredictionErrataFilters[])("returns without querying for an empty filter", async (filters) => {
    const db = errataDb();

    await expect(loadPredictionErrata(db, filters)).resolves.toEqual([]);
    expect(db.getHistory()).toHaveLength(0);
  });
});
