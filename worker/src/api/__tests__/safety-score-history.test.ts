import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { describe, expect, it } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { handleSafetyScoreHistory } from "../safety-score-history";

function makeHistoryRow(
  overrides: Partial<{
    recorded_at: number;
    grade: string;
    score: number | null;
    prev_grade: string | null;
    prev_score: number | null;
    methodology_version: string;
  }> = {},
) {
  return {
    recorded_at: 1_772_000_000,
    grade: "B+",
    score: 78,
    prev_grade: "B",
    prev_score: 74,
    methodology_version: "5.5",
    ...overrides,
  };
}

describe("handleSafetyScoreHistory", () => {
  it("rejects out-of-range day windows instead of clamping them", async () => {
    const res = await handleSafetyScoreHistory(
      mockD1([]),
      new URL("https://x/api/safety-score-history?stablecoin=usdt-tether&days=99999"),
    );
    expect(await readJsonResponse(res, 400)).toEqual({ error: "Invalid days: must be between 1 and 3650" });
  });

  it("returns 200 with history rows mapped to camelCase", async () => {
    const db = mockD1([
      {
        match: "safety_grade_history",
        rows: [makeHistoryRow()],
      },
      {
        match: "cron_runs",
        rows: [],
        first: { started_at: Math.floor(Date.now() / 1000) - 30 },
      },
    ]);

    const res = await handleSafetyScoreHistory(
      db,
      new URL("https://x/api/safety-score-history?stablecoin=usdt-tether&days=3650"),
    );

    const body = (await readJsonResponse(res, 200)) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      date: 1_772_000_000,
      grade: "B+",
      score: 78,
      prevGrade: "B",
      prevScore: 74,
      methodologyVersion: "5.5",
    });
    expect(body[0]).not.toHaveProperty("recorded_at");
    expect(body[0]).not.toHaveProperty("prev_grade");
    expect(body[0]).not.toHaveProperty("transitionKind");
    const historyQuery = db.getHistory().find((entry) => entry.sql.includes("safety_score_history_v2"));
    expect(historyQuery?.sql).toContain("FROM safety_grade_history legacy");
    expect(historyQuery?.sql).toContain("'initial-baseline', 'organic-grade-change'");
  });

  it("preserves an initial NR row with null score and predecessor", async () => {
    const db = mockD1([
      { match: "safety_grade_history", rows: [makeHistoryRow({ grade: "NR", score: null, prev_grade: null, prev_score: null })] },
      { match: "cron_runs", rows: [], first: null },
    ]);
    const response = await handleSafetyScoreHistory(db, new URL("https://x/api/safety-score-history?stablecoin=usdt-tether"));
    expect(await readJsonResponse(response, 200)).toEqual([{
      date: 1_772_000_000, grade: "NR", score: null, prevGrade: null, prevScore: null, methodologyVersion: "5.5",
    }]);
  });

  it("returns empty array when no rows exist", async () => {
    const db = mockD1([
      { match: "safety_grade_history", rows: [] },
      { match: "cron_runs", rows: [], first: null },
    ]);

    const res = await handleSafetyScoreHistory(
      db,
      new URL("https://x/api/safety-score-history?stablecoin=usdt-tether"),
    );

    expect(await readJsonResponse(res, 200)).toEqual([]);
  });

  it("includes X-Data-Age header", async () => {
    const db = mockD1([
      { match: "safety_grade_history", rows: [makeHistoryRow()] },
      {
        match: "cron_runs",
        rows: [],
        first: { started_at: Math.floor(Date.now() / 1000) - 20 },
      },
    ]);

    const res = await handleSafetyScoreHistory(
      db,
      new URL("https://x/api/safety-score-history?stablecoin=usdt-tether"),
    );

    expect(res.headers.has("X-Data-Age")).toBe(true);
    const age = Number(res.headers.get("X-Data-Age"));
    expect(age).toBeLessThan(120);
  });
});

registerStablecoinParameterContract({
  name: "safety score history",
  path: "/api/safety-score-history",
  invoke: handleSafetyScoreHistory,
});
