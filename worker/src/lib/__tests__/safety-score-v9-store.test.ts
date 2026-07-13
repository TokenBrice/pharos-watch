import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowAttempt,
  buildSafetyScoreV9ShadowDay,
  buildSafetyScoreV9ShadowEnvelope,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9ReplayArtifactKind,
} from "../safety-score-v9-shadow";
import {
  SAFETY_SCORE_V9_SHADOW_CACHE_KEYS,
  SafetyScoreV9StoreConflictError,
  buildSafetyScoreV9ReplayArtifact,
  loadLatestSafetyScoreV9DiffReport,
  loadLatestSafetyScoreV9ShadowEnvelope,
  loadSafetyScoreV9ReplayArtifact,
  loadSafetyScoreV9ShadowHistory,
  parseSafetyScoreV9ReplayArtifact,
  persistSafetyScoreV9ReplayArtifact,
  persistSafetyScoreV9ShadowAttempt,
  persistSafetyScoreV9ShadowState,
  type SafetyScoreV9StoredReplayArtifact,
} from "../safety-score-v9-store";

const SHADOW_MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0200_safety_score_v9_shadow_history.sql",
);
// The fixture intentionally executes the checked-in migration verbatim.
const SHADOW_MIGRATION = readFileSync(SHADOW_MIGRATION_PATH, "utf8");

const digest = (character: string) => character.repeat(64);
const BASE_INPUT_GENERATION_ID = `report-cards-input:v1:${digest("a")}`;
const FACT_SET_DIGEST = digest("b");
const POLICY_DIGEST = digest("c");
const EVALUATION_BUILD_DIGEST = digest("d");
const RESULT_DIGEST = digest("e");
const COMPILER_FACT_SCHEMA_DIGEST = digest("f");
const PRODUCER_CAPABILITY_DIGEST = digest("1");
const SCHEDULED_FOR_SEC = 1_700_000_000;

function createTestDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    ${SHADOW_MIGRATION}
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function candidate(): SafetyScoreV9Response {
  return {
    model: "v9-critical-path",
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v9-store-test",
    policyVersion: "candidate-v9-store-test",
    publicationGenerationId: "v9-shadow:test-generation",
    publicationEpoch: 1,
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    factSetDigest: FACT_SET_DIGEST,
    resultDigest: RESULT_DIGEST,
    policy: { id: "candidate-v9-store-test", semanticDigest: POLICY_DIGEST },
    evaluationBuildDigest: EVALUATION_BUILD_DIGEST,
    sourceGenerations: { registry: "registry:test" },
    asOfSec: SCHEDULED_FOR_SEC,
    publishedAtSec: SCHEDULED_FOR_SEC + 20,
    completeness: { expectedCount: 0, ratedCount: 0, notRatedCount: 0, notRatedIds: [] },
    cards: [],
  };
}

const ARTIFACT_IDENTITIES: Record<SafetyScoreV9ReplayArtifactKind, string> = {
  "base-input": BASE_INPUT_GENERATION_ID,
  "fact-set": FACT_SET_DIGEST,
  policy: POLICY_DIGEST,
  "evaluation-build": EVALUATION_BUILD_DIGEST,
  result: RESULT_DIGEST,
};

async function buildArtifactSet(): Promise<SafetyScoreV9StoredReplayArtifact[]> {
  return Promise.all(
    (["base-input", "fact-set", "policy", "evaluation-build", "result"] as const).map((kind) =>
      buildSafetyScoreV9ReplayArtifact({
        kind,
        identity: ARTIFACT_IDENTITIES[kind],
        value: { artifact: kind, version: 1 },
        createdAtSec: SCHEDULED_FOR_SEC + 21,
      }),
    ),
  );
}

async function successfulState() {
  const artifacts = await buildArtifactSet();
  const references = await Promise.all(
    artifacts.map(async (artifact) => (await parseSafetyScoreV9ReplayArtifact(artifact)).reference),
  );
  const envelope = buildSafetyScoreV9ShadowEnvelope({
    candidate: candidate(),
    expectedActiveIds: [],
    compilerFactSchemaDigest: COMPILER_FACT_SCHEMA_DIGEST,
    producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
    coverageFloors: [],
    replayArtifacts: references,
  });
  const v8: SafetyScoreV8ComparableSnapshot = {
    model: "v8",
    publicationGenerationId: "v8:test-generation",
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    methodologyVersion: "v8.17",
    evaluationBuildDigest: digest("2"),
    cards: [],
  };
  const diff = buildSafetyScoreV9DiffReport({
    generatedAtSec: SCHEDULED_FOR_SEC + 22,
    expectedActiveIds: [],
    v8,
    v9: envelope,
    topCutoffIds: new Set(),
    downstreamThresholds: [],
    supplyUsdById: {},
  });
  const attempt = buildSafetyScoreV9ShadowAttempt({
    attemptId: "scheduled:2023-11-14:test",
    trigger: "scheduled",
    retryOfAttemptId: null,
    scheduledForSec: SCHEDULED_FOR_SEC,
    startedAtSec: SCHEDULED_FOR_SEC + 1,
    completedAtSec: SCHEDULED_FOR_SEC + 23,
    recordedAtSec: SCHEDULED_FOR_SEC + 24,
    outcome: "succeeded",
    envelope,
  });
  const day = buildSafetyScoreV9ShadowDay({
    utcDay: attempt.utcDay,
    expectedScheduledAttemptIds: [attempt.attemptId],
    attempts: [attempt],
  });
  return { artifacts, envelope, diff, attempt, day };
}

describe("Safety Score v9 replay artifacts", () => {
  it("round-trips canonical JSON and rejects a checksum mutation", async () => {
    const artifact = await buildSafetyScoreV9ReplayArtifact({
      kind: "policy",
      identity: POLICY_DIGEST,
      value: { zeta: [3, 2, 1], alpha: "stable" },
      createdAtSec: SCHEDULED_FOR_SEC,
    });
    const parsed = await parseSafetyScoreV9ReplayArtifact<{ alpha: string; zeta: number[] }>(artifact, {
      expectedKind: "policy",
      expectedIdentity: POLICY_DIGEST,
    });

    expect(parsed.value).toEqual({ alpha: "stable", zeta: [3, 2, 1] });
    expect(parsed.canonicalJson).toBe('{"alpha":"stable","zeta":[3,2,1]}');
    expect(parsed.reference).toMatchObject({
      kind: "policy",
      identity: POLICY_DIGEST,
      artifactRef: artifact.artifactKey,
      contentSha256: artifact.contentSha256,
      verification: { status: "verified", observedContentSha256: artifact.contentSha256 },
    });

    const wrongChecksum = digest("9");
    await expect(
      parseSafetyScoreV9ReplayArtifact({
        ...artifact,
        artifactKey: `policy:${wrongChecksum}`,
        contentSha256: wrongChecksum,
      }),
    ).rejects.toThrow("checksum mismatch");
  });

  it("rejects configured byte limits and an already-aborted build", async () => {
    await expect(
      buildSafetyScoreV9ReplayArtifact(
        {
          kind: "result",
          identity: RESULT_DIGEST,
          value: { padding: "x".repeat(200) },
          createdAtSec: SCHEDULED_FOR_SEC,
        },
        { maxUncompressedBytes: 32 },
      ),
    ).rejects.toThrow("maximum is 32");

    const controller = new AbortController();
    controller.abort(new Error("shadow store stopped"));
    await expect(
      buildSafetyScoreV9ReplayArtifact(
        {
          kind: "result",
          identity: RESULT_DIGEST,
          value: { ok: true },
          createdAtSec: SCHEDULED_FOR_SEC,
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("shadow store stopped");
  });

  it("uses an immutable insert and fails closed when one identity changes content", async () => {
    const { sqlite, db } = createTestDatabase();
    const prepare = vi.spyOn(db, "prepare");
    const original = await buildSafetyScoreV9ReplayArtifact({
      kind: "fact-set",
      identity: FACT_SET_DIGEST,
      value: { generation: 1 },
      createdAtSec: SCHEDULED_FOR_SEC,
    });
    const conflict = await buildSafetyScoreV9ReplayArtifact({
      kind: "fact-set",
      identity: FACT_SET_DIGEST,
      value: { generation: 2 },
      createdAtSec: SCHEDULED_FOR_SEC + 1,
    });

    await expect(persistSafetyScoreV9ReplayArtifact(db, original)).resolves.toEqual(original);
    await expect(persistSafetyScoreV9ReplayArtifact(db, original)).resolves.toEqual(original);
    await expect(persistSafetyScoreV9ReplayArtifact(db, conflict)).rejects.toBeInstanceOf(
      SafetyScoreV9StoreConflictError,
    );

    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_artifacts").get()).toEqual({ count: 1 });
    const sql = prepare.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toMatch(/INSERT\s+OR\s+REPLACE/i);
    await expect(loadSafetyScoreV9ReplayArtifact(db, "fact-set", FACT_SET_DIGEST)).resolves.toEqual(original);
  });
});

describe("Safety Score v9 shadow state persistence", () => {
  it("persists attempts, canonical days, artifacts, and atomic latest cache values", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();

    await persistSafetyScoreV9ShadowState(db, state);

    expect(sqlite.prepare("SELECT outcome, qualifying FROM safety_score_v9_shadow_attempts").get()).toEqual({
      outcome: "succeeded",
      qualifying: 1,
    });
    expect(
      sqlite
        .prepare(
          "SELECT canonical_attempt_id, qualifying, expected_attempt_count, recorded_attempt_count FROM safety_score_v9_shadow_days",
        )
        .get(),
    ).toEqual({
      canonical_attempt_id: state.attempt.attemptId,
      qualifying: 1,
      expected_attempt_count: 1,
      recorded_attempt_count: 1,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_artifacts").get()).toEqual({ count: 5 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 2 });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(state.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(state.diff);
    await expect(loadSafetyScoreV9ShadowHistory(db)).resolves.toEqual([state.day]);

    const conflictingAttempt = { ...state.attempt, recordedAtSec: state.attempt.recordedAtSec + 1 };
    await expect(persistSafetyScoreV9ShadowAttempt(db, conflictingAttempt)).rejects.toBeInstanceOf(
      SafetyScoreV9StoreConflictError,
    );
  });

  it("rolls back artifacts, attempt, day, and envelope when the atomic latest write fails", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();
    sqlite.exec(`
      CREATE TRIGGER reject_v9_diff_cache
      BEFORE INSERT ON cache
      WHEN NEW.key = '${SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff}'
      BEGIN
        SELECT RAISE(ABORT, 'injected v9 diff cache failure');
      END;
    `);

    await expect(persistSafetyScoreV9ShadowState(db, state)).rejects.toThrow("injected v9 diff cache failure");
    for (const table of [
      "safety_score_v9_artifacts",
      "safety_score_v9_shadow_attempts",
      "safety_score_v9_shadow_days",
      "cache",
    ]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
  });

  it("fails closed when the latest envelope cache is malformed", async () => {
    const { sqlite, db } = createTestDatabase();
    sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, '{"schemaVersion":1}', SCHEDULED_FOR_SEC);

    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow();
  });
});
