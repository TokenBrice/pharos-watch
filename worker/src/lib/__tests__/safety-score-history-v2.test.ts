import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import * as activeSafetyScoreSource from "../safety-score-active-source";
import { buildReportCardsFixedInputCacheEntry, createReportCardsFixedInput } from "../report-cards-fixed-input";
import { buildPublishedReportCardsSnapshotCacheEntry } from "../report-cards-snapshot-cache";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import type { ReportCard } from "@shared/types/report-cards";
import {
  ActiveV8SafetyScoreHistorySourceInactiveError,
  SAFETY_SCORE_HISTORY_TAPE_SOURCE_SQL,
  fetchSafetyScoreHistoryCompatibilityRows,
  fetchSafetyScoreHistoryV2Rows,
  loadActiveV8SafetyScoreHistorySource,
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
const HISTORY_V2_MIGRATION = readFileSync(resolve(MIGRATIONS_DIR, "0201_safety_score_history_v2.sql"), "utf8");
const HISTORY_V2_IDENTITY_SCHEMA_MIGRATION = readFileSync(
  resolve(MIGRATIONS_DIR, "0204_safety_score_history_v2_identity_schema.sql"),
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

function v9Identity() {
  return {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: "9.0",
    policyId: "v9-rc-1",
    policyDigest: digest("d"),
    evaluationBuildDigest: digest("e"),
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    publicationGenerationId: "safety-score-v9:300",
  };
}

function historyCard(id: string): ReportCard {
  const dimension = { grade: "A" as const, score: 90, detail: "fixture" };
  return {
    id,
    name: id,
    symbol: id,
    overallGrade: "A",
    overallScore: 90,
    baseScore: 90,
    dimensions: {
      pegStability: dimension,
      liquidity: dimension,
      resilience: dimension,
      decentralization: dimension,
      dependencyRisk: dimension,
    },
    ratedDimensions: 5,
    rawInputs: createReportCardRawInputs(),
    isDefunct: false,
  };
}

async function canonicalCacheValues() {
  const activeAssetIds = [...ACTIVE_IDS].sort();
  const dexUpdatedAt = 100;
  const fixedInput = createReportCardsFixedInput({
    captureKind: "exact-publication-inputs",
    activeAssetIds,
    capturedAt: "1970-01-01T00:03:20.000Z",
    sourceGeneration: MODEL_GENERATION_ID,
    dexGenerationId: `dex-liquidity-${dexUpdatedAt}`,
    redemptionGenerationId: "redemption-backstops-unavailable",
    registryRevision: "history-test",
    methodologyVersion: METHODOLOGY,
    clockSec: 200,
    updatedAt: 200,
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: dexUpdatedAt, ageSeconds: 100, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    pegDataById: {},
    activeDepegPeakBpsById: {},
    dexLiqMap: Object.fromEntries(
      activeAssetIds.map((id) => [
        id,
        {
          liquidityScore: 90,
          concentrationHhi: 0.5,
          poolCount: 1,
          chainCount: 1,
          methodologyVersion: "history-test",
          updatedAt: dexUpdatedAt,
        },
      ]),
    ),
    redemptionBackstopMap: {},
    bluechipMap: {},
    resolvedBlacklistStatuses: Object.fromEntries(activeAssetIds.map((id) => [id, false])),
    liveReserveMap: {},
    liveReserveProvenanceMap: {},
    chainCirculatingById: {},
    dexDeploymentSupplyCoverageById: {},
    collateralDriftCoins: [],
    liveToFallbackCoins: [],
  });
  const identity = buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: METHODOLOGY,
    baseInputGenerationId: fixedInput.baseInputGenerationId,
    publicationGenerationId: MODEL_GENERATION_ID,
  });
  const publication = {
    generationId: MODEL_GENERATION_ID,
    methodologyVersion: METHODOLOGY,
    expectedCount: activeAssetIds.length,
    scoredCount: activeAssetIds.length,
    notRatedCount: 0,
    notRatedIds: [],
  };
  const full = await buildPublishedReportCardsSnapshotCacheEntry({
    safetyScoreIdentity: identity,
    cards: activeAssetIds.map(historyCard),
    methodology: {
      version: METHODOLOGY,
      weights: { pegStability: 0, liquidity: 0.3, resilience: 0.2, decentralization: 0.15, dependencyRisk: 0.25 },
      pegMultiplierExponent: 0.4,
      thresholds: [],
    },
    dependencyGraph: { edges: [] },
    updatedAt: 200,
    publication,
  });
  const fixed = await buildReportCardsFixedInputCacheEntry(fixedInput, identity);
  return { full, fixed, identity };
}

describe("Safety Score history V2", () => {
  it("retains exact provenance while comparing ordinary publications within one model series", () => {
    const current = v8Identity();
    const refreshed = v8Identity({
      baseInputGenerationId: `report-cards-input:v1:${digest("c")}`,
      publicationGenerationId: "report-cards:8.17:201",
    });

    expect(safetyScoreHistoryIdentitiesMatch(current, refreshed)).toBe(false);
    expect(safetyScoreHistoryIdentitiesAreComparable(current, refreshed)).toBe(true);
    expect(safetyScoreHistoryIdentitiesAreComparable(current, v9Identity())).toBe(false);
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

  it("loads the canonical V8 snapshot with no activation marker only when its exact fixed-input identity agrees", async () => {
    const sqlite = new DatabaseSync(":memory:");
    createLegacySchema(sqlite);
    sqlite.exec(HISTORY_V2_MIGRATION);
    sqlite.exec(HISTORY_V2_IDENTITY_SCHEMA_MIGRATION);
    const db = createSqliteD1(sqlite);
    const artifacts = await canonicalCacheValues();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, 200)");
    insert.run(artifacts.full.key, artifacts.full.value);
    insert.run(artifacts.fixed.key, artifacts.fixed.value);

    const source = await loadActiveV8SafetyScoreHistorySource(db);

    expect(source.snapshot.cards).toHaveLength(ACTIVE_IDS.size);
    expect(source.identity).toEqual(artifacts.identity);
    expect(source.identity.evaluationBuildDigest).toBe(SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST);
    expect(source.publishedAtSec).toBe(200);

    const mismatchedFixed = JSON.parse(artifacts.fixed.value) as {
      safetyScoreIdentity: { publicationGenerationId: string };
    };
    mismatchedFixed.safetyScoreIdentity.publicationGenerationId = "report-cards:8.17:201";
    sqlite
      .prepare("UPDATE cache SET value = ? WHERE key = ?")
      .run(JSON.stringify(mismatchedFixed), artifacts.fixed.key);
    await expect(loadActiveV8SafetyScoreHistorySource(db)).rejects.toThrow(/identities disagree|identity mismatch/);
  });

  it("rejects the V8 history source when a valid activation selects V9", async () => {
    const activeSourceSpy = vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource").mockResolvedValueOnce({
      kind: "v9",
      expectedModel: "v9",
    } as never);

    await expect(
      loadActiveV8SafetyScoreHistorySource({} as D1Database),
    ).rejects.toBeInstanceOf(ActiveV8SafetyScoreHistorySourceInactiveError);
    activeSourceSpy.mockRestore();
  });

  it.each([
    ["a malformed marker", "activation-marker-invalid"],
    ["a mismatched activation identity", "v9-identity-mismatch"],
  ] as const)("rejects the V8 history source for %s", async (_label, reason) => {
    const activeSourceSpy = vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreSource").mockResolvedValueOnce({
      kind: "error",
      expectedModel: "v9",
      reason,
      detail: `test ${reason}`,
    } as never);

    await expect(
      loadActiveV8SafetyScoreHistorySource({} as D1Database),
    ).rejects.toThrow(reason);
    activeSourceSpy.mockRestore();
  });
});
