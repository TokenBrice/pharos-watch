import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { collectGradeTransitions } from "../daily-digest/collectors-risk";
import type {
  CanonicalSafetyGradeRow,
  CollectorContext,
} from "../daily-digest/collectors-shared";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";

const openDatabases: DatabaseSync[] = [];
const nowSec = 1_785_000_000;
const identity: SafetyScoreV9PublicationIdentity = {
  model: "v9",
  schemaVersion: 1,
  methodologyVersion: "9.0",
  policyId: "safety-score-v9",
  policyDigest: "a".repeat(64),
  evaluationBuildDigest: "b".repeat(64),
  baseInputGenerationId: `report-cards-input:v1:${"c".repeat(64)}`,
  publicationGenerationId: "report-cards:v9:current",
};

function createHarness(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE safety_score_history_v2 (
      history_id TEXT PRIMARY KEY,
      stablecoin_id TEXT NOT NULL,
      recorded_at INTEGER NOT NULL,
      model TEXT NOT NULL,
      identity_schema_version INTEGER NOT NULL,
      methodology_version TEXT NOT NULL,
      policy_id TEXT,
      policy_digest TEXT,
      evaluation_build_digest TEXT NOT NULL,
      base_input_generation_id TEXT NOT NULL,
      model_publication_generation_id TEXT NOT NULL,
      transition_kind TEXT NOT NULL,
      grade TEXT NOT NULL,
      score REAL,
      prev_grade TEXT,
      prev_score REAL
    );
  `);
  openDatabases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function insertHistory(
  sqlite: DatabaseSync,
  overrides: Partial<{
    historyId: string;
    transitionKind: string;
    policyId: string;
    policyDigest: string;
    evaluationBuildDigest: string;
    baseInputGenerationId: string;
    publicationGenerationId: string;
    prevGrade: string | null;
    prevScore: number | null;
  }> = {},
): void {
  sqlite.prepare(
    `INSERT INTO safety_score_history_v2 (
       history_id, stablecoin_id, recorded_at, model, identity_schema_version,
       methodology_version, policy_id, policy_digest, evaluation_build_digest,
       base_input_generation_id, model_publication_generation_id, transition_kind,
       grade, score, prev_grade, prev_score
     ) VALUES (?, 'usdt-tether', ?, 'v9', 1, '9.0', ?, ?, ?, ?, ?, ?, 'A', 88, ?, ?)`,
  ).run(
    overrides.historyId ?? "organic-current",
    nowSec - 60,
    overrides.policyId ?? identity.policyId,
    overrides.policyDigest ?? identity.policyDigest,
    overrides.evaluationBuildDigest ?? identity.evaluationBuildDigest,
    overrides.baseInputGenerationId ?? `report-cards-input:v1:${"d".repeat(64)}`,
    overrides.publicationGenerationId ?? "report-cards:v9:prior",
    overrides.transitionKind ?? "organic-grade-change",
    overrides.prevGrade === undefined ? "B+" : overrides.prevGrade,
    overrides.prevScore === undefined ? 84 : overrides.prevScore,
  );
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe("daily digest Safety Score transitions", () => {
  it("uses comparable V2 organic rows and excludes activation/build/policy boundaries", async () => {
    const { sqlite, db } = createHarness();
    insertHistory(sqlite);
    insertHistory(sqlite, {
      historyId: "activation-boundary",
      transitionKind: "methodology-boundary-baseline",
      prevGrade: null,
      prevScore: null,
    });
    insertHistory(sqlite, {
      historyId: "other-build",
      evaluationBuildDigest: "e".repeat(64),
    });
    insertHistory(sqlite, {
      historyId: "other-policy",
      policyId: "other-policy",
      policyDigest: "f".repeat(64),
    });

    const asset = makeAsset({
      id: "usdt-tether",
      symbol: "USDT",
      circulating: { peggedUSD: 100_000_000 },
    });
    const ctx: CollectorContext = {
      db,
      trackedStablecoinAssets: [asset],
      trackedStablecoinIds: new Set([asset.id]),
      coreAggregateStablecoinAssets: [asset],
      coreAggregateStablecoinIds: new Set([asset.id]),
      stablecoinAssetById: new Map([[asset.id, asset]]),
      mcapById: new Map([[asset.id, 100_000_000]]),
      stablecoinsCacheIsFresh: true,
      nowSec,
      todayTs: nowSec - (nowSec % 86_400),
      yesterdayTs: nowSec - (nowSec % 86_400) - 86_400,
    };
    const pillar = {
      score: 88,
      evidenceLevel: "strong",
      freshness: "current",
      reasons: [{ code: "bounded-mechanism-review", message: "Reviewed" }],
    };
    const grades: CanonicalSafetyGradeRow[] = [{
      id: asset.id,
      symbol: asset.symbol,
      grade: "A",
      score: 88,
      pillars: { backing: pillar, exit: pillar, control: pillar },
      reasonCodes: ["bounded-mechanism-review"],
      caps: [],
      bindingCap: null,
    }];

    const transitions = await collectGradeTransitions(ctx, grades, identity);

    expect(transitions).toHaveLength(1);
    expect(transitions?.[0]).toMatchObject({
      historyId: "organic-current",
      model: "v9",
      symbol: "USDT",
      fromGrade: "B+",
      toGrade: "A",
      safetyScoreIdentity: {
        model: "v9",
        policyId: identity.policyId,
        evaluationBuildDigest: identity.evaluationBuildDigest,
        baseInputGenerationId: `report-cards-input:v1:${"d".repeat(64)}`,
        publicationGenerationId: "report-cards:v9:prior",
      },
      currentPillars: {
        backing: { score: 88 },
        exit: { score: 88 },
        control: { score: 88 },
      },
    });
  });
});
