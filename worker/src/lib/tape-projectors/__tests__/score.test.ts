import { describe, expect, it } from "vitest";
import { mockD1, type MockD1Database, type MockTableConfig } from "../../../test-helpers/__shared/mock-d1";
import { projectScoreDowngraded, projectScoreUpgraded } from "../score";

const SEC = 1_700_000_000;
const MATCH_GRADE_HISTORY = "FROM safety_grade_history";

function gradeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stablecoin_id: "usdt-tether",
    recorded_at: SEC,
    grade: "A",
    score: 90,
    prev_grade: "B",
    prev_score: 75,
    methodology_version: "8.11",
    transition_kind: "organic-grade-change",
    source_table: "safety_grade_history",
    source_row_id: `usdt-tether:${SEC}`,
    row_sort_id: `legacy:usdt-tether:${SEC}`,
    ...overrides,
  };
}

function tables(rows: Record<string, unknown>[], cursor?: number): MockTableConfig[] {
  return [
    {
      match: "FROM cache WHERE key",
      rows: cursor == null ? [] : [{ key: "tape-projector:cursor:score.upgraded", value: String(cursor) }],
    },
    { match: MATCH_GRADE_HISTORY, rows },
  ];
}

function extractInsertBinds(db: MockD1Database): unknown[][] {
  return db
    .getHistory()
    .filter((entry) => entry.sql.includes("INSERT OR REPLACE INTO tape_events"))
    .map((entry) => entry.binds);
}

function extractCacheWriteBinds(db: MockD1Database, cursorKey: string): unknown[][] {
  return db
    .getHistory()
    .filter(
      (entry) =>
        entry.sql.includes("INSERT OR REPLACE INTO cache") && entry.binds[0] === `tape-projector:cursor:${cursorKey}`,
    )
    .map((entry) => entry.binds);
}

describe("score projector", () => {
  it("routes grade upgrades to score.upgraded with info severity", async () => {
    const db = mockD1(tables([gradeRow()])) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 1, advanced: SEC });
    const inserts = extractInsertBinds(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("score.upgraded");
    expect(inserts[0]![2]).toBe("info");
    expect(inserts[0]![13]).toBe("usdt-tether:1700000000");
  });

  it("routes grade downgrades and scales severity by rank delta", async () => {
    const db = mockD1(
      tables([gradeRow({ grade: "B-", score: 65, prev_grade: "A", prev_score: 85 })]),
    ) as MockD1Database;

    const result = await projectScoreDowngraded(db);

    expect(result).toEqual({ projected: 1, advanced: SEC });
    const inserts = extractInsertBinds(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("score.downgraded");
    expect(inserts[0]![2]).toBe("severe");
  });

  it("skips equal-rank rows but advances the watermark past them", async () => {
    const db = mockD1(tables([gradeRow({ grade: "B", prev_grade: "B" })])) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 0, advanced: SEC });
    expect(extractInsertBinds(db)).toHaveLength(0);
    expect(extractCacheWriteBinds(db, "score.upgraded")[0]?.[1]).toBe(String(SEC));
  });

  it("expands a full batch through same-timestamp grade rows before advancing the watermark", async () => {
    const limitedRows = [
      gradeRow({ stablecoin_id: "usdt-tether", source_row_id: `usdt-tether:${SEC}`, row_sort_id: "1" }),
      gradeRow({ stablecoin_id: "usdc-circle", source_row_id: `usdc-circle:${SEC}`, row_sort_id: "2" }),
    ];
    const expandedRows = [
      ...limitedRows,
      gradeRow({ stablecoin_id: "dai-makerdao", source_row_id: `dai-makerdao:${SEC}`, row_sort_id: "3" }),
    ];
    const db = mockD1([
      { match: "FROM cache WHERE key", rows: [] },
      { match: MATCH_GRADE_HISTORY, matchBinds: [0, 2], rows: limitedRows },
      { match: MATCH_GRADE_HISTORY, matchBinds: [0, SEC], rows: expandedRows },
    ]) as MockD1Database;

    const result = await projectScoreUpgraded(db, { maxRows: 2 });

    expect(result).toEqual({ projected: 3, advanced: SEC });
    expect(extractInsertBinds(db).map((binds) => binds[13])).toEqual([
      "usdt-tether:1700000000",
      "usdc-circle:1700000000",
      "dai-makerdao:1700000000",
    ]);
    expect(extractCacheWriteBinds(db, "score.upgraded")[0]?.[1]).toBe(String(SEC));
  });

  it("treats unknown grades as lower than NR for guarded fallback ordering", async () => {
    const db = mockD1(
      tables([gradeRow({ grade: "NR", score: null, prev_grade: "UNKNOWN", prev_score: null })]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result.projected).toBe(1);
    const inserts = extractInsertBinds(db);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![1]).toBe("score.upgraded");
  });

  it("preserves V2 source identity for organic rows", async () => {
    const db = mockD1(
      tables([
        gradeRow({
          source_table: "safety_score_history_v2",
          source_row_id: "safety-score-history:v2:event:123",
          row_sort_id: "v2:safety-score-history:v2:event:123",
        }),
      ]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result.projected).toBe(1);
    const inserts = extractInsertBinds(db);
    expect(inserts[0]?.[12]).toBe("safety_score_history_v2");
    expect(inserts[0]?.[13]).toBe("safety-score-history:v2:event:123");
  });

  it("does not project methodology-boundary baselines as organic movements", async () => {
    const db = mockD1(
      tables([
        gradeRow({
          transition_kind: "methodology-boundary-baseline",
          prev_grade: null,
          prev_score: null,
        }),
      ]),
    ) as MockD1Database;

    const result = await projectScoreUpgraded(db);

    expect(result).toEqual({ projected: 0, advanced: SEC });
    expect(extractInsertBinds(db)).toHaveLength(0);
  });

  it("does not insert events or advance the cursor during dry runs", async () => {
    const db = mockD1(tables([gradeRow()])) as MockD1Database;

    const result = await projectScoreUpgraded(db, { dryRun: true });

    expect(result).toEqual({ projected: 1, advanced: null });
    expect(extractInsertBinds(db)).toHaveLength(0);
    expect(extractCacheWriteBinds(db, "score.upgraded")).toHaveLength(0);
  });
});
