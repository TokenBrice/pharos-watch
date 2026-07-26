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
} from "../../lib/safety-score-v9-shadow";
import {
  SAFETY_SCORE_V9_SHADOW_CACHE_KEYS,
  persistSafetyScoreV9ShadowState,
} from "../../lib/safety-score-v9-store";
import type { SafetyScoreHistoryBoundaryOperationInput } from "../../lib/safety-score-history-boundary-operation";
import {
  SAFETY_SCORE_HISTORY_BOUNDARY_REQUEST_SCHEMA_VERSION,
  SafetyScoreHistoryBoundaryResponseSchema,
  createHandleAdminSafetyScoreV9HistoryBoundary,
  handleAdminSafetyScoreV9,
  handleAdminSafetyScoreV9MovementReview,
} from "../admin-safety-score-v9";

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

async function persistAvailableState(
  db: D1Database,
  options: {
    expectedActiveIds?: string[];
    v8Cards?: SafetyScoreV8ComparableSnapshot["cards"];
  } = {},
) {
  const envelope = buildSafetyScoreV9ShadowEnvelope({
    candidate: candidate(),
    expectedActiveIds: options.expectedActiveIds ?? [],
    compilerFactSchemaDigest: digest("f"),
    producerCapabilityDigest: digest("1"),
    coverageFloors: [],
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
  });
  await persistSafetyScoreV9ShadowState(db, {
    envelope,
    diff,
    daily,
    exactInput: {
      key: "report-cards:v9-fixed-input:exact",
      value: '{"fixture":"admin-v9-exact-input"}',
    },
    publicationHealth: {
      schemaVersion: 1,
      status: "current",
      acceptedPublicationGenerationId:
        envelope.candidate.publicationGenerationId,
      acceptedAtSec: envelope.candidate.publishedAtSec,
      attemptedAtSec: envelope.candidate.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    },
    publicationClockSec: envelope.candidate.publishedAtSec,
  });
  return { envelope, v8, diff };
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

function historyBoundaryRequest(
  body: unknown,
  options: { idempotencyKey?: string; adminHeader?: boolean } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.idempotencyKey !== undefined) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.adminHeader !== false) headers.set("X-Pharos-Admin", "1");
  return new Request("https://ops-api.pharos.watch/api/admin-safety-score-v9/history-boundary", {
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
      expect(body.history[0]?.selectedRun?.archiveSelectionReasons).toEqual([]);
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
          rationale: "This movement is caused by a scoring defect and requires owner review.",
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

describe("admin Safety Score history boundary", () => {
  const expectedIdentity = {
    model: "v9" as const,
    schemaVersion: 1 as const,
    methodologyVersion: candidate().policyVersion,
    policyId: candidate().policy.id,
    policyDigest,
    evaluationBuildDigest,
    baseInputGenerationId,
    publicationGenerationId: candidate().publicationGenerationId,
  };
  const body = {
    schemaVersion: SAFETY_SCORE_HISTORY_BOUNDARY_REQUEST_SCHEMA_VERSION,
    operation: "activate-v9" as const,
    expectedIdentity,
    recordedAtSec: scheduledForSec + 100,
  };

  it("invokes only the exact idempotent boundary operation and never writes the activation marker", async () => {
    const { sqlite, db } = createTestDatabase();
    const executeBoundary = vi.fn(async (_db: D1Database, input: SafetyScoreHistoryBoundaryOperationInput) => ({
      operation: input.operation,
      transitionKind: "methodology-boundary-baseline" as const,
      identity: input.expectedIdentity,
      recordedAtSec: input.recordedAtSec,
      cardCount: 1,
      changes: 1,
    }));
    const handler = createHandleAdminSafetyScoreV9HistoryBoundary({
      executeBoundary,
      nowSec: () => scheduledForSec + 101,
    });

    const first = await handler({
      db,
      request: historyBoundaryRequest(body, { idempotencyKey: "history-boundary-001" }),
      trustedAdmin: true,
    });
    expect(first.status).toBe(201);
    expect(first.headers.get("X-Idempotent-Replay")).toBe("false");
    const parsed = SafetyScoreHistoryBoundaryResponseSchema.parse(await first.json());
    expect(parsed).toMatchObject({
      status: "recorded",
      operation: "activate-v9",
      transitionKind: "methodology-boundary-baseline",
      identity: expectedIdentity,
      recordedAtSec: scheduledForSec + 100,
      cardCount: 1,
      changes: 1,
    });
    expect(executeBoundary).toHaveBeenCalledWith(db, {
      operation: "activate-v9",
      expectedIdentity,
      recordedAtSec: scheduledForSec + 100,
      createdAtSec: scheduledForSec + 101,
      signal: expect.any(AbortSignal),
    });

    const replay = await handler({
      db,
      request: historyBoundaryRequest(body, { idempotencyKey: "history-boundary-001" }),
      trustedAdmin: true,
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get("X-Idempotent-Replay")).toBe("true");
    expect(await replay.json()).toEqual(parsed);
    expect(executeBoundary).toHaveBeenCalledTimes(1);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM cache WHERE key = ?").get("safety-score-v9:public-activation"),
    ).toEqual({ count: 0 });
    sqlite.close();
  });

  it("rejects a model-incompatible operation before invoking the boundary primitive", async () => {
    const { sqlite, db } = createTestDatabase();
    const executeBoundary = vi.fn();
    const handler = createHandleAdminSafetyScoreV9HistoryBoundary({ executeBoundary });

    const response = await handler({
      db,
      request: historyBoundaryRequest(
        { ...body, operation: "rollback-v8" },
        { idempotencyKey: "history-boundary-002" },
      ),
      trustedAdmin: true,
    });

    expect(response.status).toBe(400);
    expect(executeBoundary).not.toHaveBeenCalled();
    sqlite.close();
  });
});
