import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import { SafetyScoreV9AdminResponseSchema } from "@shared/types/safety-score-v9-admin";
import {
  SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
  SafetyScoreV9MovementReviewResponseSchema,
} from "@shared/types/safety-score-v9-review";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowDailySuccess,
  buildSafetyScoreV9ShadowEnvelope,
  safetyScoreV9UtcDay,
  type SafetyScoreV8ComparableSnapshot,
  type SafetyScoreV9ReplayArtifactKind,
} from "../../lib/safety-score-v9-shadow";
import {
  buildSafetyScoreV9ReplayArtifact,
  SAFETY_SCORE_V9_SHADOW_CACHE_KEYS,
  parseSafetyScoreV9ReplayArtifact,
  persistSafetyScoreV9ShadowState,
  type SafetyScoreV9StoredReplayArtifact,
} from "../../lib/safety-score-v9-store";
import {
  serializeSafetyScoreV9DiffReportCacheValue,
  serializeSafetyScoreV9ShadowEnvelopeCacheValue,
} from "../../lib/safety-score-v9-cache-codec";
import { handleAdminSafetyScoreV9, handleAdminSafetyScoreV9MovementReview } from "../admin-safety-score-v9";

const migrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0200_safety_score_v9_shadow_history.sql",
);
const migration = readFileSync(migrationPath, "utf8");
const movementReviewsMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0202_safety_score_v9_movement_reviews.sql",
);
const movementReviewCarryMigrationPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0220_safety_score_v9_movement_review_carry.sql",
);
const movementReviewMigration = [
  readFileSync(movementReviewsMigrationPath, "utf8"),
  readFileSync(movementReviewCarryMigrationPath, "utf8"),
].join("\n");
const digest = (character: string) => character.repeat(64);
const scheduledForSec = 1_700_000_000;
const baseInputGenerationId = `report-cards-input:v1:${digest("a")}`;
const factSetDigest = digest("b");
const policyDigest = digest("c");
const evaluationBuildDigest = digest("d");
const resultDigest = digest("e");

function createTestDatabase(): { sqlite: DatabaseSync; db: D1Database } {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE admin_idempotency_keys (
      action TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      reservation_owner TEXT,
      reservation_generation INTEGER NOT NULL DEFAULT 0,
      execution_started_at INTEGER,
      PRIMARY KEY (action, idempotency_key)
    );
    ${migration}
    ${movementReviewMigration}
  `);
  return { sqlite, db: createSqliteD1(sqlite) };
}

function candidate(): SafetyScoreV9Response {
  return {
    model: "v9-critical-path",
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v9-admin-test",
    policyVersion: "candidate-v1",
    publicationGenerationId: "v9-shadow:admin-test",
    baseInputGenerationId,
    factSetDigest,
    resultDigest,
    policy: { id: "safety-score-v9-candidate-v1", semanticDigest: policyDigest },
    evaluationBuildDigest,
    sourceGenerations: { registry: "registry:test" },
    asOfSec: scheduledForSec,
    publishedAtSec: scheduledForSec + 20,
    completeness: { expectedCount: 0, ratedCount: 0, notRatedCount: 0, notRatedIds: [] },
    cards: [],
  };
}

const artifactIdentities: Record<SafetyScoreV9ReplayArtifactKind, string> = {
  "base-input": baseInputGenerationId,
  "fact-set": factSetDigest,
  policy: policyDigest,
  "evaluation-build": evaluationBuildDigest,
  result: resultDigest,
};

async function buildArtifacts(): Promise<SafetyScoreV9StoredReplayArtifact[]> {
  return Promise.all(
    (["base-input", "fact-set", "policy", "evaluation-build", "result"] as const).map((kind) =>
      buildSafetyScoreV9ReplayArtifact({
        kind,
        identity: artifactIdentities[kind],
        value: { kind, fixture: true },
        createdAtSec: scheduledForSec + 21,
      }),
    ),
  );
}

async function persistAvailableState(
  db: D1Database,
  options: {
    expectedActiveIds?: string[];
    v8Cards?: SafetyScoreV8ComparableSnapshot["cards"];
  } = {},
) {
  const artifacts = await buildArtifacts();
  const references = await Promise.all(
    artifacts.map(async (artifact) => (await parseSafetyScoreV9ReplayArtifact(artifact)).reference),
  );
  const envelope = buildSafetyScoreV9ShadowEnvelope({
    candidate: candidate(),
    expectedActiveIds: options.expectedActiveIds ?? [],
    compilerFactSchemaDigest: digest("f"),
    producerCapabilityDigest: digest("1"),
    coverageFloors: [],
    replayArtifacts: references,
  });
  const v8: SafetyScoreV8ComparableSnapshot = {
    model: "v8",
    publicationGenerationId: "v8:admin-test",
    baseInputGenerationId,
    methodologyVersion: "v8.17",
    evaluationBuildDigest: digest("2"),
    cards: options.v8Cards ?? [],
  };
  const diff = buildSafetyScoreV9DiffReport({
    generatedAtSec: scheduledForSec + 22,
    expectedActiveIds: options.expectedActiveIds ?? [],
    v8,
    v9: envelope,
    topCutoffIds: new Set(),
    downstreamThresholds: [],
    supplyUsdById: {},
  });
  const daily = buildSafetyScoreV9ShadowDailySuccess({
    utcDay: safetyScoreV9UtcDay(scheduledForSec),
    selectedAtSec: scheduledForSec + 23,
    updatedAtSec: scheduledForSec + 24,
    envelope,
    diff,
    archiveSelectionReasons: ["first"],
    artifactKeys: artifacts.map((artifact) => artifact.artifactKey),
  });
  await persistSafetyScoreV9ShadowState(db, { artifacts, envelope, diff, daily });
  return { envelope, v8, diff, references };
}

function request() {
  return new Request("https://ops-api.pharos.watch/api/admin-safety-score-v9");
}

function reviewRequest(body: unknown, options: { idempotencyKey?: string; adminHeader?: boolean } = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.idempotencyKey !== undefined) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.adminHeader !== false) headers.set("X-Pharos-Admin", "1");
  return new Request("https://ops-api.pharos.watch/api/admin-safety-score-v9/reviews", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("admin Safety Score v9 candidate", () => {
  it("returns the exact stored envelope, diff, and history with no-store", async () => {
    const { sqlite, db } = createTestDatabase();
    await persistAvailableState(db);

    const response = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = SafetyScoreV9AdminResponseSchema.parse(await response.json());
    expect(body.status).toBe("available");
    if (body.status === "available") {
      expect(body.envelope.candidate.publicationGenerationId).toBe("v9-shadow:admin-test");
      expect(body.envelope.releaseCoveragePolicyDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(body.envelope.consumerThresholdRegistryDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(body.diff.v9Identity.publicationGenerationId).toBe("v9-shadow:admin-test");
      expect(body.movementReviews).toEqual([]);
      expect(body.history).toHaveLength(1);
      expect(body.history[0]?.attemptCounts).toEqual({ successful: 1, failed: 0 });
      expect(body.history[0]?.selectedRun?.identity.publicationGenerationId).toBe("v9-shadow:admin-test");
      expect(body.history[0]?.selectedRun?.identity.releaseCoveragePolicyDigest).toBe(
        body.envelope.releaseCoveragePolicyDigest,
      );
      expect(body.history[0]?.selectedRun?.identity.consumerThresholdRegistryDigest).toBe(
        body.envelope.consumerThresholdRegistryDigest,
      );
      expect(body.history[0]?.selectedRun?.archiveSelectionReasons).toEqual(["first"]);
    }
    sqlite.close();
  });

  it("surfaces the latest run in the display slot while the selection stays pinned", async () => {
    const { sqlite, db } = createTestDatabase();
    await persistAvailableState(db);

    // Before any intra-day refresh lands, the display slot falls back to the
    // selected (qualifying) pair.
    const fallback = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: true });
    const fallbackBody = SafetyScoreV9AdminResponseSchema.parse(await fallback.json());
    expect(fallbackBody.status).toBe("available");
    if (fallbackBody.status === "available") {
      expect(fallbackBody.latestEnvelope.candidate.publicationGenerationId).toBe("v9-shadow:admin-test");
      expect(fallbackBody.latestDiff.v9Identity.publicationGenerationId).toBe("v9-shadow:admin-test");
    }

    // A later same-day run refreshes only the display slot.
    const lateCandidate = {
      ...candidate(),
      candidateId: "candidate-v9-admin-late",
      policyVersion: "candidate-v9-admin-late",
      publicationGenerationId: "v9-shadow:admin-late",
      resultDigest: digest("8"),
    };
    const lateEnvelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: lateCandidate,
      expectedActiveIds: [],
      compilerFactSchemaDigest: digest("f"),
      producerCapabilityDigest: digest("1"),
      coverageFloors: [],
      replayArtifacts: [],
    });
    const lateV8: SafetyScoreV8ComparableSnapshot = {
      model: "v8",
      publicationGenerationId: "v8:admin-test",
      baseInputGenerationId,
      methodologyVersion: "v8.17",
      evaluationBuildDigest: digest("2"),
      cards: [],
    };
    const lateDiff = buildSafetyScoreV9DiffReport({
      generatedAtSec: scheduledForSec + 3 * 60 * 60,
      expectedActiveIds: [],
      v8: lateV8,
      v9: lateEnvelope,
      topCutoffIds: new Set(),
      downstreamThresholds: [],
      supplyUsdById: {},
    });
    const insertCache = sqlite.prepare("INSERT OR REPLACE INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insertCache.run(
      SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.latestEnvelope,
      await serializeSafetyScoreV9ShadowEnvelopeCacheValue(lateEnvelope),
      scheduledForSec + 3 * 60 * 60,
    );
    insertCache.run(
      SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.latestDiff,
      await serializeSafetyScoreV9DiffReportCacheValue(lateDiff),
      scheduledForSec + 3 * 60 * 60,
    );

    const response = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: true });
    const body = SafetyScoreV9AdminResponseSchema.parse(await response.json());
    expect(body.status).toBe("available");
    if (body.status === "available") {
      // The display follows the latest run.
      expect(body.latestEnvelope.candidate.publicationGenerationId).toBe("v9-shadow:admin-late");
      expect(body.latestDiff.v9Identity.publicationGenerationId).toBe("v9-shadow:admin-late");
      // The qualifying selection and its retained history stay pinned.
      expect(body.envelope.candidate.publicationGenerationId).toBe("v9-shadow:admin-test");
      expect(body.diff.v9Identity.publicationGenerationId).toBe("v9-shadow:admin-test");
      expect(body.history[0]?.selectedRun?.identity.publicationGenerationId).toBe("v9-shadow:admin-test");
    }
    sqlite.close();
  });

  it("returns a typed unavailable response and no partial data before first shadow publication", async () => {
    const { sqlite, db } = createTestDatabase();
    const response = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: true });
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "shadow-envelope-unavailable",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    sqlite.close();
  });

  it("refuses to combine independently valid candidate generations", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await persistAvailableState(db);
    const otherCandidate = { ...candidate(), publicationGenerationId: "v9-shadow:other-generation" };
    const otherEnvelope = buildSafetyScoreV9ShadowEnvelope({
      candidate: otherCandidate,
      expectedActiveIds: [],
      compilerFactSchemaDigest: digest("f"),
      producerCapabilityDigest: digest("1"),
      coverageFloors: [],
      replayArtifacts: state.references,
    });
    const otherDiff = buildSafetyScoreV9DiffReport({
      generatedAtSec: scheduledForSec + 30,
      expectedActiveIds: [],
      v8: state.v8,
      v9: otherEnvelope,
      topCutoffIds: new Set(),
      downstreamThresholds: [],
      supplyUsdById: {},
    });
    sqlite
      .prepare("UPDATE cache SET value = ? WHERE key = ?")
      .run(stableJsonStringifyV1(otherDiff), SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff);

    const response = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: true });
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "shadow-generation-mismatch",
    });
    sqlite.close();
  });

  it("fails closed without the trusted admin context", async () => {
    const { sqlite, db } = createTestDatabase();
    const response = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: false });
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    sqlite.close();
  });
});

describe("admin Safety Score v9 movement reviews", () => {
  async function reviewableState(db: D1Database) {
    const state = await persistAvailableState(db, {
      expectedActiveIds: ["review-asset"],
      v8Cards: [
        {
          id: "review-asset",
          score: 82,
          grade: "B",
          bindingCap: null,
          reasonCodes: [],
        },
      ],
    });
    const card = state.diff.cards[0]!;
    expect(card.review.status).toBe("pending");
    expect(card.review.key).not.toBeNull();
    return {
      ...state,
      body: {
        schemaVersion: SAFETY_SCORE_V9_MOVEMENT_REVIEW_SCHEMA_VERSION,
        reviewKey: card.review.key!,
        assetId: card.id,
        sourceDiffReportDigest: state.diff.reportDigest,
        disposition: "producer-data-gap" as const,
        reviewerId: "operator@example.com",
        rationale: "The candidate is missing the reviewed V9 producer facts required to rate this asset.",
      },
    };
  }

  it("records one immutable review and replays an identical idempotent request", async () => {
    const { sqlite, db } = createTestDatabase();
    const { body } = await reviewableState(db);
    const first = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(body, { idempotencyKey: "review-asset-001" }),
      trustedAdmin: true,
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("X-Idempotent-Replay")).toBe("false");
    const parsed = SafetyScoreV9MovementReviewResponseSchema.parse(await first.json());
    expect(parsed).toMatchObject({
      status: "recorded",
      review: {
        reviewKey: body.reviewKey,
        disposition: "producer-data-gap",
        reviewerId: "operator@example.com",
      },
    });

    const replay = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(body, { idempotencyKey: "review-asset-001" }),
      trustedAdmin: true,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(parsed);

    const clock = vi.spyOn(Date, "now").mockReturnValue((scheduledForSec + 5_000) * 1_000);
    const independentlyRetried = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(body, { idempotencyKey: "review-asset-002" }),
      trustedAdmin: true,
    });
    clock.mockRestore();
    expect(independentlyRetried.status).toBe(200);
    expect(SafetyScoreV9MovementReviewResponseSchema.parse(await independentlyRetried.json())).toEqual({
      ...parsed,
      status: "unchanged",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_movement_reviews").get()).toEqual({
      count: 1,
    });

    const dashboard = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: true });
    const dashboardBody = SafetyScoreV9AdminResponseSchema.parse(await dashboard.json());
    expect(dashboardBody.status).toBe("available");
    if (dashboardBody.status === "available") {
      expect(dashboardBody.movementReviews).toEqual([parsed.review]);
    }
    sqlite.close();
  });

  it("rejects stale targets and immutable reclassification", async () => {
    const { sqlite, db } = createTestDatabase();
    const { body } = await reviewableState(db);
    const stale = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest({ ...body, sourceDiffReportDigest: digest("9") }, { idempotencyKey: "review-stale-001" }),
      trustedAdmin: true,
    });
    expect(stale.status).toBe(409);

    const recorded = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(body, { idempotencyKey: "review-record-001" }),
      trustedAdmin: true,
    });
    expect(recorded.status).toBe(201);
    const conflict = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(
        {
          ...body,
          disposition: "defect",
          rationale: "This movement is caused by a scoring defect and must block activation.",
        },
        { idempotencyKey: "review-conflict-001" },
      ),
      trustedAdmin: true,
    });
    expect(conflict.status).toBe(409);
    sqlite.close();
  });

  it("fails the candidate read closed when a retained review is corrupted", async () => {
    const { sqlite, db } = createTestDatabase();
    const { body } = await reviewableState(db);
    const recorded = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(body, { idempotencyKey: "review-corruption-001" }),
      trustedAdmin: true,
    });
    expect(recorded.status).toBe(201);
    sqlite
      .prepare("UPDATE safety_score_v9_movement_reviews SET review_json = ? WHERE review_key = ?")
      .run('{"corrupted":true}', body.reviewKey);

    const dashboard = await handleAdminSafetyScoreV9({ db, request: request(), trustedAdmin: true });
    expect(await dashboard.json()).toEqual({
      schemaVersion: 1,
      status: "unavailable",
      reason: "stored-shadow-invalid",
    });
    sqlite.close();
  });

  it("requires both the mutation fence and a well-formed idempotency key", async () => {
    const { sqlite, db } = createTestDatabase();
    const { body } = await reviewableState(db);
    const missingFence = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(body, { idempotencyKey: "review-auth-001", adminHeader: false }),
      trustedAdmin: true,
    });
    expect(missingFence.status).toBe(403);

    const missingKey = await handleAdminSafetyScoreV9MovementReview({
      db,
      request: reviewRequest(body),
      trustedAdmin: true,
    });
    expect(missingKey.status).toBe(400);
    expect(missingKey.headers.get("Cache-Control")).toBe("no-store");
    sqlite.close();
  });
});
