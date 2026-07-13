import { describe, expect, it } from "vitest";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
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
    recorded_at: overrides.recorded_at ?? 1_772_000_000,
    grade: overrides.grade ?? "B+",
    score: overrides.score ?? 78,
    prev_grade: overrides.prev_grade ?? "B",
    prev_score: overrides.prev_score ?? 74,
    methodology_version: overrides.methodology_version ?? "5.5",
  };
}

describe("handleSafetyScoreHistory", () => {
  it("returns 400 when stablecoin param is missing", async () => {
    const res = await handleSafetyScoreHistory(mockD1([]), new URL("https://x/api/safety-score-history"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing ?stablecoin= parameter" });
  });

  it("returns 404 for unknown stablecoin ID", async () => {
    const res = await handleSafetyScoreHistory(
      mockD1([]),
      new URL("https://x/api/safety-score-history?stablecoin=DROP TABLE"),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Unknown stablecoin" });
  });

  it("rejects out-of-range day windows instead of clamping them", async () => {
    const res = await handleSafetyScoreHistory(
      mockD1([]),
      new URL("https://x/api/safety-score-history?stablecoin=usdt-tether&days=99999"),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid days: must be between 1 and 3650" });
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

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      date: body[0].date,
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

  it("returns empty array when no rows exist", async () => {
    const db = mockD1([
      { match: "safety_grade_history", rows: [] },
      { match: "cron_runs", rows: [], first: null },
    ]);

    const res = await handleSafetyScoreHistory(
      db,
      new URL("https://x/api/safety-score-history?stablecoin=usdt-tether"),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
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
