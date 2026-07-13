import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { publishSafetyScoreV8ModelFamily } from "../safety-score-model-publication-store";
import {
  SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL,
  fetchSafetyScoreHistoryCompatibilityRows,
  loadActiveV8SafetyScoreHistorySource,
  prepareV8OrganicSafetyScoreHistoryWrites,
  safetyScoreLegacyHistoryV2Id,
  type SafetyScoreHistoryV8Identity,
} from "../safety-score-history-v2";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../migrations");
const V9_PUBLICATION_MIGRATION = readFileSync(
  resolve(MIGRATIONS_DIR, "0200_safety_score_v9_shadow_history.sql"),
  "utf8",
);
const HISTORY_V2_MIGRATION = readFileSync(resolve(MIGRATIONS_DIR, "0201_safety_score_history_v2.sql"), "utf8");
const digest = (character: string) => character.repeat(64);
const METHODOLOGY = "8.17";
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
  return { sqlite, db: createSqliteD1(sqlite) };
}

function v8Identity(overrides: Partial<SafetyScoreHistoryV8Identity> = {}): SafetyScoreHistoryV8Identity {
  return {
    model: "v8",
    methodologyVersion: METHODOLOGY,
    policyId: null,
    policyDigest: null,
    evaluationBuildDigest: digest("b"),
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    modelPublicationGenerationId: MODEL_GENERATION_ID,
    publicationEpoch: 0,
    ...overrides,
  };
}

function fullPayload(): string {
  return JSON.stringify({
    generation: 3,
    methodologyVersion: METHODOLOGY,
    payload: {
      cards: [],
      methodology: {
        version: METHODOLOGY,
        weights: {
          pegStability: 0,
          liquidity: 0.3,
          resilience: 0.2,
          decentralization: 0.15,
          dependencyRisk: 0.25,
        },
        pegMultiplierExponent: 0.4,
        thresholds: [],
      },
      dependencyGraph: { edges: [] },
      updatedAt: 200,
      publication: {
        generationId: MODEL_GENERATION_ID,
        methodologyVersion: METHODOLOGY,
        expectedCount: 0,
        scoredCount: 0,
        notRatedCount: 0,
        notRatedIds: [],
      },
    },
  });
}

describe("Safety Score history V2", () => {
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
                  model_publication_generation_id, publication_epoch, transition_kind,
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
      publication_epoch: 0,
      transition_kind: "organic-grade-change",
      prev_grade: "B+",
      prev_score: 79,
      legacy_recorded_at: 200,
    });
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
          model_publication_generation_id, publication_epoch, transition_kind,
          grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        0,
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
          model_publication_generation_id, publication_epoch, transition_kind,
          grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        1,
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

  it("enforces discriminated policy identity and non-comparable boundary predecessors", () => {
    const { sqlite } = createHistoryDatabase();
    const statement = sqlite.prepare(
      `INSERT INTO safety_score_history_v2
       (history_id, stablecoin_id, recorded_at, model, methodology_version,
        policy_id, policy_digest, evaluation_build_digest, base_input_generation_id,
        model_publication_generation_id, publication_epoch, transition_kind,
        grade, score, prev_grade, prev_score, legacy_recorded_at, created_at)
       VALUES (?, 'usdc-circle', 300, 'v9', '9.0', ?, ?, ?, ?, ?, 1, ?, 'A', 88, ?, ?, NULL, 301)`,
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

  it("loads the exact immutable V8 family selected by the active manifest", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createLegacySchema(sqlite);
    sqlite.exec(V9_PUBLICATION_MIGRATION);
    sqlite.exec(HISTORY_V2_MIGRATION);
    const db = createSqliteD1(sqlite);
    await publishSafetyScoreV8ModelFamily({
      db,
      generationId: MODEL_GENERATION_ID,
      baseInputGenerationId: BASE_INPUT_GENERATION_ID,
      publishedAtSec: 200,
      methodologyVersion: METHODOLOGY,
      evaluationBuildDigest: digest("b"),
      payloads: {
        full: { key: "report-cards:snapshot", value: fullPayload() },
        compact: { key: "report_card_cache", value: "{}" },
        alert: { key: "alert:safety-source-cache", value: "{}" },
        fixedInput: { key: "report-cards:fixed-input:exact", value: "{}" },
      },
    });

    const source = await loadActiveV8SafetyScoreHistorySource(db);

    expect(source.snapshot.cards).toEqual([]);
    expect(source.identity).toEqual(v8Identity());
    expect(source.publishedAtSec).toBe(200);
  });
});
