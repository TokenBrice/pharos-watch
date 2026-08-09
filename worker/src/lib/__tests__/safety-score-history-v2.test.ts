import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import {
  safetyScorePublicationIdentitiesAreComparable,
  safetyScorePublicationIdentitiesMatch,
} from "@shared/lib/safety-score-publication";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import {
  SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL,
  fetchSafetyScoreHistoryCompatibilityRows,
  fetchSafetyScoreHistoryV2Rows,
  prepareSafetyScoreHistoryBoundaryWrite,
  prepareSafetyScoreHistoryBoundaryWrites,
  prepareSafetyScoreHistoryV2Write,
  prepareV8OrganicSafetyScoreHistoryWrites,
  safetyScoreHistoryIdentitiesAreComparable,
  safetyScoreHistoryIdentitiesMatch,
  safetyScoreHistoryIdentityFromV2Row,
  safetyScoreLegacyHistoryV2Id,
  type SafetyScoreHistoryV8Identity,
} from "../safety-score-history-v2";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../migrations");
const FIXTURES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../test-helpers/migration-fixtures");

// Migrations absorbed by the 2026-07-30 baseline squash live on as frozen test fixtures.
function resolveMigrationPath(file: string): string {
  const fixture = resolve(FIXTURES_DIR, file);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
  return existsSync(fixture) ? fixture : resolve(MIGRATIONS_DIR, file);
}
// eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
const HISTORY_V2_MIGRATION = readFileSync(resolveMigrationPath("0201_safety_score_history_v2.sql"), "utf8");
// eslint-disable-next-line security/detect-non-literal-fs-filename -- repo-controlled test fixture path
const HISTORY_V2_IDENTITY_SCHEMA_MIGRATION = readFileSync(
  resolveMigrationPath("0204_safety_score_history_v2_identity_schema.sql"),
  "utf8",
);
const digest = (character: string) => character.repeat(64);
const METHODOLOGY = SAFETY_SCORE_METHODOLOGY_VERSION;
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${digest("a")}`;
const MODEL_GENERATION_ID = `report-cards:${METHODOLOGY}:200`;

function createLegacySchema(sqlite: DatabaseSync): void {
  sqlite.exec(`
    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE safety_grade_history (
      stablecoin_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      grade TEXT NOT NULL,
      score REAL,
      prev_grade TEXT,
      prev_score REAL,
      methodology_version TEXT NOT NULL,
      PRIMARY KEY (stablecoin_id, recorded_at)
    );
  `);
}

function createHistoryDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  createLegacySchema(sqlite);
  sqlite.exec(HISTORY_V2_MIGRATION);
  sqlite.exec(HISTORY_V2_IDENTITY_SCHEMA_MIGRATION);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function v8Identity(overrides: Partial<SafetyScoreHistoryV8Identity> = {}): SafetyScoreHistoryV8Identity {
  return {
    model: "v8",
    schemaVersion: 1,
    methodologyVersion: METHODOLOGY,
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    publicationGenerationId: MODEL_GENERATION_ID,
    ...overrides,
  };
}

function v9Identity(
  overrides: Partial<SafetyScoreV9PublicationIdentity> = {},
): SafetyScoreV9PublicationIdentity {
  return {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "9.0",
    policyId: "v9-rc-1",
    policyDigest: digest("d"),
    evaluationBuildDigest: digest("e"),
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    publicationGenerationId: "safety-score-v9:300",
    ...overrides,
  };
}

describe("Safety Score history V2", () => {
  it("matches the shared V8/V9 identity split and merge contract", () => {
    const v8Current = v8Identity();
    const v8Refreshed = v8Identity({
      baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
      publicationGenerationId: "report-cards:8.17:201",
    });
    const v9Current = v9Identity();
    const v9Refreshed = v9Identity({
      baseInputGenerationId: `report-cards-input:v1:${digest("f")}`,
      publicationGenerationId: "safety-score-v9:301",
    });
    const v9PolicyBoundary = v9Identity({ policyDigest: digest("f") });

    const comparisons = [
      { left: v8Current, right: v8Current, exact: true, comparable: true },
      { left: v8Current, right: v8Refreshed, exact: false, comparable: true },
      { left: v9Current, right: v9Current, exact: true, comparable: true },
      { left: v9Current, right: v9Refreshed, exact: false, comparable: true },
      { left: v9Current, right: v9PolicyBoundary, exact: false, comparable: false },
      { left: v8Current, right: v9Current, exact: false, comparable: false },
    ];

    for (const { left, right, exact, comparable } of comparisons) {
      expect(safetyScoreHistoryIdentitiesMatch(left, right)).toBe(exact);
      expect(safetyScoreHistoryIdentitiesAreComparable(left, right)).toBe(comparable);
      expect(safetyScoreHistoryIdentitiesMatch(left, right)).toBe(
        safetyScorePublicationIdentitiesMatch(left, right),
      );
      expect(safetyScoreHistoryIdentitiesAreComparable(left, right)).toBe(
        safetyScorePublicationIdentitiesAreComparable(left, right),
      );
    }
  });

  it("dual-writes a legacy organic row and its immutable identity-rich V2 twin", async () => {
    const { sqlite, db } = createHistoryDatabase();
    const statements = prepareV8OrganicSafetyScoreHistoryWrites(db, {
      stablecoinId: "usdc-circle",
      recordedAt: 200,
      grade: "A",
      score: 88,
      prevGrade: "B+",
      prevScore: 79,
      transitionKind: "organic-grade-change",
      identity: v8Identity(),
      createdAt: 205,
    });

    await db.batch([...statements]);
    await db.batch([...statements]);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_grade_history").get()).toEqual({ count: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_history_v2").get()).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare(
          `SELECT history_id, model, methodology_version, policy_id, policy_digest,
                  evaluation_build_digest, base_input_generation_id,
                  model_publication_generation_id, transition_kind,
                  prev_grade, prev_score, legacy_recorded_at
             FROM safety_score_history_v2`,
        )
        .get(),
    ).toEqual({
      history_id: safetyScoreLegacyHistoryV2Id("usdc-circle", 200),
      model: "v8",
      methodology_version: METHODOLOGY,
      policy_id: null,
      policy_digest: null,
      evaluation_build_digest: digest("b"),
      base_input_generation_id: BASE_INPUT_GENERATION_ID,
      model_publication_generation_id: MODEL_GENERATION_ID,
      transition_kind: "organic-grade-change",
      prev_grade: "B+",
      prev_score: 79,
      legacy_recorded_at: 200,
    });
  });

  it("writes a V9 boundary without creating a legacy projection", async () => {
    const { sqlite, db } = createHistoryDatabase();
    await db.batch([
      prepareSafetyScoreHistoryBoundaryWrite(db, {
        stablecoinId: "usdc-circle",
        recordedAt: 300,
        grade: "A",
        score: 88,
        transitionKind: "methodology-boundary-baseline",
        identity: v9Identity(),
        createdAt: 301,
      }),
    ]);

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_grade_history").get()).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          `SELECT model, policy_id, policy_digest, transition_kind, prev_grade, legacy_recorded_at
             FROM safety_score_history_v2`,
        )
        .get(),
    ).toEqual({
      model: "v9",
      policy_id: "v9-rc-1",
      policy_digest: digest("d"),
      transition_kind: "methodology-boundary-baseline",
      prev_grade: null,
      legacy_recorded_at: null,
    });
  });

  it("writes bounded rollback baselines without legacy projections or duplicate cards", async () => {
    const { sqlite, db } = createHistoryDatabase();
    await db.batch(prepareSafetyScoreHistoryBoundaryWrites(db, {
      cards: [
        { stablecoinId: "usdc-circle", grade: "A", score: 88 },
        { stablecoinId: "usdt-tether", grade: "B+", score: 82 },
      ],
      recordedAt: 300,
      transitionKind: "rollback-baseline",
      identity: v9Identity(),
      createdAt: 301,
    }));

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_grade_history").get()).toEqual({ count: 0 });
    expect(
      sqlite.prepare(
        `SELECT stablecoin_id, transition_kind, prev_grade, legacy_recorded_at
           FROM safety_score_history_v2
          ORDER BY stablecoin_id`,
      ).all(),
    ).toEqual([
      {
        stablecoin_id: "usdc-circle",
        transition_kind: "rollback-baseline",
        prev_grade: null,
        legacy_recorded_at: null,
      },
      {
        stablecoin_id: "usdt-tether",
        transition_kind: "rollback-baseline",
        prev_grade: null,
        legacy_recorded_at: null,
      },
    ]);

    expect(() => prepareSafetyScoreHistoryBoundaryWrites(db, {
      cards: [
        { stablecoinId: "usdc-circle", grade: "A", score: 88 },
        { stablecoinId: "usdc-circle", grade: "A", score: 88 },
      ],
      recordedAt: 300,
      transitionKind: "rollback-baseline",
      identity: v9Identity(),
      createdAt: 301,
    })).toThrow("Duplicate Safety Score boundary card");
  });

  it("rejects a conflicting replay of one V9 history identity", async () => {
    const { db } = createHistoryDatabase();
    const input = {
      stablecoinId: "usdc-circle",
      recordedAt: 300,
      grade: "A" as const,
      score: 88,
      prevGrade: null,
      prevScore: null,
      transitionKind: "methodology-boundary-baseline" as const,
      identity: v9Identity(),
      createdAt: 301,
    };
    await db.batch([prepareSafetyScoreHistoryV2Write(db, input)]);

    await expect(
      db.batch([
        prepareSafetyScoreHistoryV2Write(db, {
          ...input,
          grade: "A-",
          createdAt: 302,
        }),
      ]),
    ).rejects.toThrow();
  });

  it("rejects organic and baseline transitions with invalid predecessor values", () => {
    const { db } = createHistoryDatabase();
    const common = {
      stablecoinId: "usdc-circle",
      recordedAt: 200,
      grade: "A" as const,
      score: 88,
      identity: v8Identity(),
      createdAt: 205,
    };

    expect(() =>
      prepareV8OrganicSafetyScoreHistoryWrites(db, {
        ...common,
        prevGrade: null,
        prevScore: 79,
        transitionKind: "organic-grade-change",
      }),
    ).toThrow("requires a previous grade");
    expect(() =>
      prepareV8OrganicSafetyScoreHistoryWrites(db, {
        ...common,
        prevGrade: "B+",
        prevScore: null,
        transitionKind: "initial-baseline",
      }),
    ).toThrow("cannot carry comparable previous values");
    expect(() =>
      prepareV8OrganicSafetyScoreHistoryWrites(db, {
        ...common,
        prevGrade: null,
        prevScore: 79,
        transitionKind: "initial-baseline",
      }),
    ).toThrow("cannot carry comparable previous values");

    expect(() =>
      prepareSafetyScoreHistoryV2Write(db, {
        ...common,
        prevGrade: "B+",
        prevScore: 79,
        transitionKind: "organic-grade-change",
      }),
    ).toThrow("requires a previous identity");
    expect(() =>
      prepareSafetyScoreHistoryV2Write(db, {
        ...common,
        prevGrade: "B+",
        prevScore: 79,
        transitionKind: "organic-grade-change",
        identity: v9Identity(),
        previousIdentity: v8Identity(),
      }),
    ).toThrow("cannot cross model or policy identities");
  });

  it("fails closed when an existing V2 identity is replayed with different provenance", async () => {
    const { db } = createHistoryDatabase();
    const common = {
      stablecoinId: "usdc-circle",
      recordedAt: 200,
      grade: "A" as const,
      score: 88,
      prevGrade: "B+" as const,
      prevScore: 79,
      transitionKind: "organic-grade-change" as const,
      createdAt: 205,
    };
    await db.batch([...prepareV8OrganicSafetyScoreHistoryWrites(db, { ...common, identity: v8Identity() })]);

    await expect(
      db.batch([
        ...prepareV8OrganicSafetyScoreHistoryWrites(db, {
          ...common,
          identity: v8Identity({ evaluationBuildDigest: digest("c") }),
        }),
      ]),
    ).rejects.toThrow();
  });

  it("dual-reads legacy gaps and V2 organic rows once while hiding boundary baselines", async () => {
    const { sqlite, db } = createHistoryDatabase();
    sqlite.exec(`
      INSERT INTO safety_grade_history VALUES
        ('usdc-circle', 100, 'B', 75, NULL, NULL, '${METHODOLOGY}'),
        ('usdc-circle', 200, 'A', 88, 'B', 75, '${METHODOLOGY}');
    `);
    await db.batch([
      ...prepareV8OrganicSafetyScoreHistoryWrites(db, {
        stablecoinId: "usdc-circle",
        recordedAt: 200,
        grade: "A",
        score: 88,
        prevGrade: "B",
        prevScore: 75,
        transitionKind: "organic-grade-change",
        identity: v8Identity(),
        createdAt: 205,
      }),
    ]);
    sqlite
      .prepare(
        `INSERT INTO safety_score_history_v2
         (history_id, stablecoin_id, recorded_at, model, methodology_version,
          policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
          model_publication_generation_id, transition_kind,
          grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "v2-only-organic",
        "usdc-circle",
        300,
        "v8",
        METHODOLOGY,
        null,
        null,
        digest("b"),
        BASE_INPUT_GENERATION_ID,
        "report-cards:8.17:300",
        "organic-grade-change",
        "A+",
        94,
        "A",
        88,
        null,
        305,
      );
    sqlite
      .prepare(
        `INSERT INTO safety_score_history_v2
         (history_id, stablecoin_id, recorded_at, model, methodology_version,
          policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
          model_publication_generation_id, transition_kind,
          grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "same-day-v9-boundary",
        "usdc-circle",
        300,
        "v9",
        "9.0",
        "v9-rc-1",
        digest("d"),
        digest("e"),
        BASE_INPUT_GENERATION_ID,
        "safety-score-v9:300",
        "methodology-boundary-baseline",
        "A",
        87,
        null,
        null,
        null,
        306,
      );

    const rows = await fetchSafetyScoreHistoryCompatibilityRows(db, "usdc-circle", 0);

    expect(rows.map((row) => [row.recorded_at, row.grade])).toEqual([
      [100, "B"],
      [200, "A"],
      [300, "A+"],
    ]);

    const tapeRows = await db
      .prepare(
        `SELECT recorded_at, transition_kind, source_table, source_row_id
           FROM ${SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL}
          WHERE recorded_at > ?
          ORDER BY recorded_at ASC, row_sort_id ASC`,
      )
      .bind(0)
      .all<{
        recorded_at: number;
        transition_kind: string;
        source_table: string;
        source_row_id: string;
      }>();
    expect(tapeRows.results).toEqual([
      {
        recorded_at: 200,
        transition_kind: "organic-grade-change",
        source_table: "safety_grade_history",
        source_row_id: "usdc-circle:200",
      },
      {
        recorded_at: 300,
        transition_kind: "organic-grade-change",
        source_table: "safety_score_history_v2",
        source_row_id: "v2-only-organic",
      },
    ]);
  });

  it("returns V2 boundaries with their full V9 identity and rejects malformed policy rows", async () => {
    const { sqlite, db } = createHistoryDatabase();
    sqlite
      .prepare(
        `INSERT INTO safety_score_history_v2
         (history_id, stablecoin_id, recorded_at, model, methodology_version,
          policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
          model_publication_generation_id, transition_kind,
          grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "v9-boundary",
        "usdc-circle",
        300,
        "v9",
        "9.0",
        "v9-rc-1",
        digest("d"),
        digest("e"),
        BASE_INPUT_GENERATION_ID,
        "safety-score-v9:300",
        "methodology-boundary-baseline",
        "A",
        88,
        null,
        null,
        null,
        301,
      );

    const [row] = await fetchSafetyScoreHistoryV2Rows(db, "usdc-circle", 0);
    expect(row).toBeDefined();
    expect(safetyScoreHistoryIdentityFromV2Row(row!)).toEqual(v9Identity());
    expect(() => safetyScoreHistoryIdentityFromV2Row({ ...row!, policy_id: null })).toThrow();
  });

  it("enforces discriminated policy identity and non-comparable boundary predecessors", () => {
    const { sqlite } = createHistoryDatabase();
    const statement = sqlite.prepare(
      `INSERT INTO safety_score_history_v2
       (history_id, stablecoin_id, recorded_at, model, methodology_version,
        policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
        model_publication_generation_id, transition_kind,
        grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
       VALUES (?, 'usdc-circle', 300, 'v9', '9.0', ?, ?, ?, ?, ?, ?, 'A', 88, ?, ?, NULL, 301)`,
    );

    expect(() =>
      statement.run(
        "missing-policy",
        null,
        null,
        digest("e"),
        BASE_INPUT_GENERATION_ID,
        "safety-score-v9:300",
        "methodology-boundary-baseline",
        null,
        null,
      ),
    ).toThrow();
    expect(() =>
      statement.run(
        "comparable-boundary",
        "v9-rc-1",
        digest("d"),
        digest("e"),
        BASE_INPUT_GENERATION_ID,
        "safety-score-v9:300",
        "methodology-boundary-baseline",
        "A-",
        82,
      ),
    ).toThrow();
  });

  it("rejects unsupported persisted identity schema versions", () => {
    const { sqlite } = createHistoryDatabase();

    expect(() => sqlite.exec(`
      INSERT INTO safety_score_history_v2
       (history_id, stablecoin_id, recorded_at, model, identity_schema_version, methodology_version,
        policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
        model_publication_generation_id, transition_kind,
        grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
       VALUES (
        'unsupported-schema-version', 'usdc-circle', 300, 'v8', 1.5, '${METHODOLOGY}',
        NULL, NULL, '${digest("b")}', '${BASE_INPUT_GENERATION_ID}', 'report-cards:8.17:300',
        'initial-baseline', 'A', 88, NULL, NULL, NULL, 301
       );
    `)).toThrow();
  });

});
