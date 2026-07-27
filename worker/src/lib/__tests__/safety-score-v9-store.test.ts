import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import type { SafetyScoreV9Response } from "@shared/types/safety-score-v9-public";
import { describe, expect, it, vi } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildSafetyScoreV9DiffReport,
  buildSafetyScoreV9ShadowDailyFailure,
  buildSafetyScoreV9ShadowDailySuccess,
  buildSafetyScoreV9ShadowEnvelope,
  type SafetyScoreV8ComparableSnapshot,
} from "../safety-score-v9-shadow";
import {
  SAFETY_SCORE_V9_SHADOW_CACHE_KEYS,
  loadLatestSafetyScoreV9DiffReport,
  loadLatestSafetyScoreV9ShadowEnvelope,
  loadSafetyScoreV9PublicationHealth,
  loadSafetyScoreV9ShadowHistory,
  persistSafetyScoreV9ShadowState,
} from "../safety-score-v9-store";
import {
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES,
} from "../safety-score-v9-cache-codec";

const SHADOW_MIGRATION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../migrations/0200_safety_score_v9_shadow_history.sql",
);
// The fixture intentionally executes the checked-in migration verbatim.
const SHADOW_MIGRATION = readFileSync(SHADOW_MIGRATION_PATH, "utf8");

const digest = (character: string) => character.repeat(64);

async function gzipBase64Utf8(value: string): Promise<{
  payload: string;
  compressedBytes: number;
  uncompressedBytes: number;
}> {
  const uncompressed = new TextEncoder().encode(value);
  const stream = new Response(uncompressed).body!.pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < compressed.length; offset += 0x8000) {
    binary += String.fromCharCode(...compressed.subarray(offset, offset + 0x8000));
  }
  return {
    payload: btoa(binary),
    compressedBytes: compressed.byteLength,
    uncompressedBytes: uncompressed.byteLength,
  };
}

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
    schemaVersion: 5,
    lifecycle: "active",
    candidateId: "safety-score-v9:v1:store-test",
    policyVersion: "9.0",
    publicationGenerationId: "report-cards:v9:v1:store-test",
    baseInputGenerationId: BASE_INPUT_GENERATION_ID,
    factSetDigest: FACT_SET_DIGEST,
    resultDigest: RESULT_DIGEST,
    policy: { id: "safety-score-v9", semanticDigest: POLICY_DIGEST },
    evaluationBuildDigest: EVALUATION_BUILD_DIGEST,
    sourceGenerations: { registry: "registry:test" },
    asOfSec: SCHEDULED_FOR_SEC,
    publishedAtSec: SCHEDULED_FOR_SEC + 20,
    completeness: { expectedCount: 0, ratedCount: 0, notRatedCount: 0, notRatedIds: [] },
    cards: [],
  };
}

function productionScaleCard(id: string, detail: string): SafetyScoreV9Response["cards"][number] {
  const pillar = {
    score: 90,
    evidenceLevel: "strong" as const,
    freshness: "current" as const,
    components: [],
    reasons: [{ code: "insufficient-evidence" as const, message: detail, path: `cards.${id}` }],
  };
  return {
    id,
    score: 90,
    grade: "A+",
    qualityScore: 90,
    pegMultiplier: 1,
    pegAdjustedScore: 90,
    pillars: { backing: pillar, exit: pillar, control: pillar },
    weakestPillar: { pillar: "backing", score: 90 },
    caps: [],
    bindingCap: null,
    nrReasons: [],
    reasonCodes: ["insufficient-evidence"],
    evidence: { level: "strong", freshness: "current", reasons: [] },
    accessPosture: {
      transfer: "permissionless",
      freezeExposure: "none-known",
      primaryExit: "permissionless",
      governance: "distributed",
      unknownFields: [],
      signals: [],
      reasons: [],
    },
    dependencies: { serial: [], basket: [], cycleBlocked: false, reasonCodes: [] },
    stressStateDigest: null,
    scoreTrace: {
      schemaVersion: 3,
      legacyAliases: {
        qualityScore: "weighted-pillar-mean",
        pegAdjustedScore: "post-deployment-pre-cap-score",
        score: "post-cap-public-score",
      },
      aggregation: {
        method: "smooth-bounded-headroom",
        score: 90,
        weightedPillarMean: 90,
        weakestPillar: "backing",
        weakestScore: 90,
        headroom: 45,
      },
      stages: {
        weightedPillarMean: 90,
        aggregatedQualityScore: 90,
        pegMultiplier: 1,
        baseAssetScore: 90,
        deploymentAdjustedScore: 90,
        deploymentAdjustmentPoints: 0,
        preCapScore: 90,
        publishedScore: 90,
      },
      deploymentRisk: {
        method: "holder-slice-exposure-weighted-v2",
        totalAdjustmentPoints: 0,
        adjustments: [],
        unresolvedExposures: [],
      },
      adverseAttribution: {
        semantics: "causal-measured-adverse-v1",
        items: [],
      },
      boundedUncertaintyAttribution: {
        semantics: "causal-bounded-uncertainty-v1",
        items: [],
      },
      evidenceResponsibility: {
        semantics: "limiting-fact-owner-v1",
        totalFactCount: 0,
        summaries: [
          { responsibility: "integration-missing", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "issuer-undisclosed", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "measured-adverse", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "method-unsupported", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
          { responsibility: "producer-failed", factCount: 0, criticalFactCount: 0, reasonCodes: [] },
        ],
      },
      scoreAdjustments: [],
      wrapperParentLimit: null,
    },
    breakdowns: {
      backing: {
        evaluatedScore: 90,
        publishedScore: 90,
        aggregationWeight: 0.4,
        groups: [{ key: "reserves", label: "Reserves", score: 90, effectiveWeight: 1 }],
        components: [{
          key: "reserve:fixture",
          label: "Fixture reserves",
          source: "reserve-exposure",
          score: 90,
          effectiveWeight: 1,
          weightedContribution: 90,
          observationState: "known",
        }],
        adjustments: [],
      },
      exit: {
        evaluatedScore: 90,
        publishedScore: 90,
        aggregationWeight: 0.35,
        stressRequest: null,
        primaryRoute: {
          key: "redemption:fixture",
          label: "Fixture redemption",
          routeFamily: "protocol-redemption",
          score: 90,
          components: [
            { key: "access", label: "Access", score: 90, weight: 0.2, weightedContribution: 18 },
            { key: "settlement", label: "Settlement", score: 90, weight: 0.15, weightedContribution: 13.5 },
            {
              key: "executionCertainty",
              label: "Execution certainty",
              score: 90,
              weight: 0.15,
              weightedContribution: 13.5,
            },
            { key: "capacity", label: "Capacity", score: 90, weight: 0.25, weightedContribution: 22.5 },
            {
              key: "outputAssetQuality",
              label: "Output asset quality",
              score: 90,
              weight: 0.15,
              weightedContribution: 13.5,
            },
            { key: "cost", label: "Cost", score: 90, weight: 0.1, weightedContribution: 9 },
          ],
          confidenceFactor: 1,
          eligibilityMultiplier: 1,
          capsApplied: [],
        },
        diversification: null,
        alternatives: [],
        adjustments: [],
      },
      control: {
        evaluatedScore: 90,
        publishedScore: 90,
        aggregationWeight: 0.25,
        method: "minimum-binding-component",
        components: [{
          key: "control:fixture",
          label: "Fixture control",
          kind: "mint",
          score: 90,
          binding: true,
          posture: "distributed",
        }],
        adjustments: [],
      },
    },
  };
}

function productionScaleCandidate(): SafetyScoreV9Response {
  const cards = Array.from({ length: 360 }, (_, index) => {
    const id = `stablecoin-${index.toString().padStart(3, "0")}`;
    const detail = [
      `asset=${id}`,
      `chain=${["ethereum", "arbitrum", "base", "solana", "polygon"][index % 5]}`,
      `source=${["issuer-attestation", "dex-liquidity", "redemption", "dependency-graph"][index % 4]}`,
      `score=${(index * 37) % 101}`,
      `liquidityUsd=${1_000_000 + index * 97}`,
      `observedAt=${1_700_000_000 + index * 300}`,
      `evidenceRef=review-${index.toString(16).padStart(8, "0")}`,
    ].join("|");
    return productionScaleCard(id, `${detail}\n`.repeat(20));
  });
  return {
    ...candidate(),
    completeness: { expectedCount: cards.length, ratedCount: cards.length, notRatedCount: 0, notRatedIds: [] },
    cards,
  };
}

function successfulState(candidateValue = candidate()) {
  const envelope = buildSafetyScoreV9ShadowEnvelope({
    candidate: candidateValue,
    expectedActiveIds: candidateValue.cards.map((card) => card.id),
    compilerFactSchemaDigest: COMPILER_FACT_SCHEMA_DIGEST,
    producerCapabilityDigest: PRODUCER_CAPABILITY_DIGEST,
    coverageFloors: [],
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
    expectedActiveIds: candidateValue.cards.map((card) => card.id),
    v8,
    v9: envelope,
    topCutoffIds: new Set(),
    downstreamThresholds: [],
    supplyUsdById: {},
  });
  const daily = buildSafetyScoreV9ShadowDailySuccess({
    utcDay: "2023-11-14",
    selectedAtSec: SCHEDULED_FOR_SEC + 23,
    updatedAtSec: SCHEDULED_FOR_SEC + 24,
    envelope,
    diff,
  });
  return {
    envelope,
    diff,
    daily,
    exactInput: {
      key: "report-cards:v9-fixed-input:exact",
      value: JSON.stringify({
        generation: candidateValue.publicationGenerationId,
      }),
    },
    publicationHealth: {
      schemaVersion: 1 as const,
      status: "current" as const,
      acceptedPublicationGenerationId:
        candidateValue.publicationGenerationId,
      acceptedAtSec: candidateValue.publishedAtSec,
      attemptedAtSec: candidateValue.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    },
    publicationClockSec: candidateValue.publishedAtSec,
  };
}

describe("Safety Score v9 shadow state persistence", () => {
  it("persists one compact daily row and atomic canonical cache values", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();

    await persistSafetyScoreV9ShadowState(db, state);

    expect(state.envelope.replayArtifacts).toEqual([]);
    expect(state.daily.selectedRun).toMatchObject({
      archiveSelectionReasons: [],
      artifactKeys: [],
    });
    expect(
      sqlite
        .prepare(
          `SELECT successful_attempt_count, failed_attempt_count, qualifying, rateable_count, nr_count,
                  release_coverage_policy_digest, consumer_threshold_registry_digest
           FROM safety_score_v9_shadow_daily`,
        )
        .get(),
    ).toEqual({
      successful_attempt_count: 1,
      failed_attempt_count: 0,
      qualifying: 1,
      rateable_count: 0,
      nr_count: 0,
      release_coverage_policy_digest: state.envelope.releaseCoveragePolicyDigest,
      consumer_threshold_registry_digest: state.envelope.consumerThresholdRegistryDigest,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_artifacts").get()).toEqual({ count: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 4 });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(state.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(state.diff);
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(
      state.publicationHealth,
    );
    await expect(loadSafetyScoreV9ShadowHistory(db)).resolves.toEqual([state.daily]);
  });

  it("round-trips a production-scale semantic envelope above the D1 value limit", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState(productionScaleCandidate());
    const semanticBytes = new TextEncoder().encode(stableJsonStringifyV1(state.envelope)).byteLength;
    expect(semanticBytes).toBeGreaterThan(2_000_000);

    await persistSafetyScoreV9ShadowState(db, state);

    const rows = sqlite.prepare("SELECT key, value FROM cache ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const storedBytes = new TextEncoder().encode(row.value).byteLength;
      expect(storedBytes).toBeLessThanOrEqual(SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES);
      expect(storedBytes).toBeLessThan(2_000_000);
    }
    const storedEnvelope = JSON.parse(
      rows.find((row) => row.key === SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope)!.value,
    ) as Record<string, unknown>;
    expect(storedEnvelope).toMatchObject({
      storageSchemaVersion: 1,
      kind: "safety-score-v9-shadow-envelope",
      encoding: "gzip-base64",
      uncompressedBytes: semanticBytes,
      identity: {
        candidateId: state.envelope.candidate.candidateId,
        publicationGenerationId: state.envelope.candidate.publicationGenerationId,
        resultDigest: state.envelope.candidate.resultDigest,
      },
    });
    expect(Number(storedEnvelope.compressedBytes)).toBeLessThanOrEqual(
      SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES,
    );
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(state.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(state.diff);
  }, 15_000);

  it("persists a hold without changing the canonical envelope, diff, or exact input", async () => {
    const { sqlite, db } = createTestDatabase();
    const accepted = await successfulState();
    await persistSafetyScoreV9ShadowState(db, accepted);
    const before = sqlite
      .prepare(
        "SELECT key, value, updated_at FROM cache WHERE key != ? ORDER BY key",
      )
      .all(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.publicationHealth);

    const attemptedAtSec = accepted.publicationClockSec + 1_800;
    const heldDaily = buildSafetyScoreV9ShadowDailyFailure({
      utcDay: accepted.daily.utcDay,
      updatedAtSec: attemptedAtSec + 5,
      previous: accepted.daily,
      failure: {
        atSec: attemptedAtSec + 5,
        stage: "publication-gate",
        code: "safety-score-v9-publication-held",
        message: "Safety Score v9 publication held: dex-stale",
      },
    });
    await persistSafetyScoreV9ShadowState(db, {
      daily: heldDaily,
      publicationHealth: {
        ...accepted.publicationHealth,
        status: "held",
        attemptedAtSec,
        heldSinceSec: attemptedAtSec,
        reasons: [{ code: "dex-stale" }],
      },
      publicationClockSec: attemptedAtSec,
    });

    expect(
      sqlite
        .prepare(
          "SELECT key, value, updated_at FROM cache WHERE key != ? ORDER BY key",
        )
        .all(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.publicationHealth),
    ).toEqual(before);
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(
      accepted.envelope,
    );
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(
      accepted.diff,
    );
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toMatchObject(
      {
        status: "held",
        acceptedPublicationGenerationId:
          accepted.envelope.candidate.publicationGenerationId,
        attemptedAtSec,
        heldSinceSec: attemptedAtSec,
        reasons: [{ code: "dex-stale" }],
      },
    );
  });

  it("continues to read legacy plain canonical cache values", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, stableJsonStringifyV1(state.envelope), SCHEDULED_FOR_SEC);
    insert.run(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff, stableJsonStringifyV1(state.diff), SCHEDULED_FOR_SEC);

    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(state.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(state.diff);

    const legacyCurrentEnvelope = structuredClone(state.envelope) as typeof state.envelope & {
      candidate: { lifecycle: "candidate" | "active" };
    };
    legacyCurrentEnvelope.candidate.lifecycle = "candidate";
    sqlite
      .prepare("UPDATE cache SET value = ? WHERE key = ?")
      .run(stableJsonStringifyV1(legacyCurrentEnvelope), SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope);

    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(state.envelope);
  });

  it("rejects corrupt, unbounded, noncanonical, and identity-mismatched cache envelopes", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();
    await persistSafetyScoreV9ShadowState(db, state);
    const statement = sqlite.prepare("SELECT value FROM cache WHERE key = ?");
    const original = (statement.get(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope) as { value: string }).value;
    const update = sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?");
    const storeMutation = (mutation: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(original) as Record<string, unknown>;
      mutation(value);
      update.run(stableJsonStringifyV1(value), SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope);
    };

    storeMutation((value) => {
      value.payloadSha256 = digest("9");
    });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow("checksum mismatch");

    storeMutation((value) => {
      value.payload = `${String(value.payload)}\n`;
    });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow("base64 payload is not canonical");

    storeMutation((value) => {
      value.uncompressedBytes = 1;
    });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow("exceeds 1 uncompressed bytes");

    storeMutation((value) => {
      value.compressedBytes = SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES + 1;
    });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow(
      `exceeds ${SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES} compressed bytes`,
    );

    storeMutation((value) => {
      (value.identity as Record<string, unknown>).publicationGenerationId = "v9-shadow:tampered-generation";
    });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow("identity mismatch");

    const bomPayload = await gzipBase64Utf8(`\uFEFF${stableJsonStringifyV1(state.envelope)}`);
    storeMutation((value) => {
      value.payload = bomPayload.payload;
      value.uncompressedBytes = bomPayload.uncompressedBytes;
      value.compressedBytes = bomPayload.compressedBytes;
    });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow("checksum mismatch");
  });

  it("fails closed when an indexed operational digest diverges from canonical daily JSON", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();
    await persistSafetyScoreV9ShadowState(db, state);

    sqlite
      .prepare("UPDATE safety_score_v9_shadow_daily SET release_coverage_policy_digest = ? WHERE utc_day = ?")
      .run(digest("9"), state.daily.utcDay);

    await expect(loadSafetyScoreV9ShadowHistory(db)).rejects.toThrow(
      `Safety Score v9 shadow daily row projection mismatch for ${state.daily.utcDay}`,
    );
  });

  it("increments a failed daily row before the first successful canonical state", async () => {
    const { sqlite, db } = createTestDatabase();
    const failure = buildSafetyScoreV9ShadowDailyFailure({
      utcDay: "2023-11-14",
      updatedAtSec: SCHEDULED_FOR_SEC + 5,
      failure: {
        atSec: SCHEDULED_FOR_SEC + 5,
        stage: "compile",
        code: "compile-failed",
        message: "compile failed",
      },
    });
    await persistSafetyScoreV9ShadowState(db, { daily: failure });
    const state = await successfulState();
    state.daily = buildSafetyScoreV9ShadowDailySuccess({
      utcDay: "2023-11-14",
      selectedAtSec: SCHEDULED_FOR_SEC + 23,
      updatedAtSec: SCHEDULED_FOR_SEC + 24,
      previous: failure,
      envelope: state.envelope,
      diff: state.diff,
    });
    await persistSafetyScoreV9ShadowState(db, state);

    expect(
      sqlite.prepare("SELECT successful_attempt_count, failed_attempt_count FROM safety_score_v9_shadow_daily").get(),
    ).toEqual({
      successful_attempt_count: 1,
      failed_attempt_count: 1,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_artifacts").get()).toEqual({ count: 0 });
  });

  it("atomically replaces the same-day canonical state and records later failures", async () => {
    const { sqlite, db } = createTestDatabase();
    const original = await successfulState();
    await persistSafetyScoreV9ShadowState(db, original);

    const refreshedCandidate = {
      ...candidate(),
      candidateId: "safety-score-v9:v1:store-refreshed",
      policyVersion: "9.0",
      publicationGenerationId: "report-cards:v9:v1:store-refreshed",
      resultDigest: digest("8"),
      publishedAtSec: SCHEDULED_FOR_SEC + 3 * 60 * 60,
    };
    const refreshed = await successfulState(refreshedCandidate);
    refreshed.daily = buildSafetyScoreV9ShadowDailySuccess({
      utcDay: original.daily.utcDay,
      selectedAtSec: SCHEDULED_FOR_SEC + 3 * 60 * 60,
      updatedAtSec: SCHEDULED_FOR_SEC + 3 * 60 * 60 + 1,
      previous: original.daily,
      envelope: refreshed.envelope,
      diff: refreshed.diff,
    });

    await expect(persistSafetyScoreV9ShadowState(db, refreshed)).resolves.toBeUndefined();
    await expect(loadSafetyScoreV9ShadowHistory(db)).resolves.toEqual([refreshed.daily]);
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(refreshed.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(refreshed.diff);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_shadow_daily").get()).toEqual({ count: 1 });

    const failure = buildSafetyScoreV9ShadowDailyFailure({
      utcDay: refreshed.daily.utcDay,
      updatedAtSec: refreshed.daily.updatedAtSec + 1,
      previous: refreshed.daily,
      failure: {
        atSec: refreshed.daily.updatedAtSec + 1,
        stage: "shadow-write",
        code: "write-failed",
        message: "write failed",
      },
    });
    await expect(persistSafetyScoreV9ShadowState(db, { daily: failure })).resolves.toBeUndefined();
    expect(
      sqlite
        .prepare(
          `SELECT successful_attempt_count, failed_attempt_count, selected_run_at_sec,
                  latest_error_code
           FROM safety_score_v9_shadow_daily`,
        )
        .get(),
    ).toEqual({
      successful_attempt_count: 2,
      failed_attempt_count: 1,
      selected_run_at_sec: refreshed.daily.selectedRun?.selectedAtSec,
      latest_error_code: "write-failed",
    });
  });

  it("rolls back the daily row and canonical cache when the paired write fails", async () => {
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
    for (const table of ["safety_score_v9_shadow_daily", "cache"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
  });

  it("keeps the winning canonical state when another writer wins after preflight", async () => {
    const { sqlite, db } = createTestDatabase();
    const raceDb = createSqliteD1(sqlite);
    const loser = await successfulState();
    const winnerCandidate = {
      ...candidate(),
      candidateId: "safety-score-v9:v1:store-race-winner",
      policyVersion: "9.0",
      publicationGenerationId: "report-cards:v9:v1:store-race-winner",
      resultDigest: digest("8"),
    };
    const winner = await successfulState(winnerCandidate);
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      await persistSafetyScoreV9ShadowState(raceDb, winner);
      return originalBatch(statements);
    });

    await expect(persistSafetyScoreV9ShadowState(db, loser)).rejects.toThrow();

    await expect(loadSafetyScoreV9ShadowHistory(raceDb)).resolves.toEqual([winner.daily]);
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(raceDb)).resolves.toEqual(winner.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(raceDb)).resolves.toEqual(winner.diff);
  });

  it("keeps the winning intra-day refresh when a stale refresh passed preflight", async () => {
    const { sqlite, db } = createTestDatabase();
    const raceDb = createSqliteD1(sqlite);
    const original = await successfulState();
    await persistSafetyScoreV9ShadowState(raceDb, original);

    const buildRefresh = async (label: string, selectedAtSec: number) => {
      const refreshed = await successfulState({
        ...candidate(),
        candidateId: `safety-score-v9:v1:store-race-${label}`,
        policyVersion: "9.0",
        publicationGenerationId: `report-cards:v9:v1:store-race-${label}`,
        resultDigest: digest(label === "winner" ? "8" : "9"),
        publishedAtSec: selectedAtSec,
      });
      refreshed.daily = buildSafetyScoreV9ShadowDailySuccess({
        utcDay: original.daily.utcDay,
        selectedAtSec,
        updatedAtSec: selectedAtSec + 1,
        previous: original.daily,
        envelope: refreshed.envelope,
        diff: refreshed.diff,
      });
      return refreshed;
    };
    const loser = await buildRefresh("loser", SCHEDULED_FOR_SEC + 3 * 60 * 60);
    const winner = await buildRefresh("winner", SCHEDULED_FOR_SEC + 3 * 60 * 60 + 1);
    const originalBatch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementation(async (statements) => {
      await persistSafetyScoreV9ShadowState(raceDb, winner);
      return originalBatch(statements);
    });

    await expect(persistSafetyScoreV9ShadowState(db, loser)).rejects.toThrow();

    await expect(loadSafetyScoreV9ShadowHistory(raceDb)).resolves.toEqual([winner.daily]);
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(raceDb)).resolves.toEqual(winner.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(raceDb)).resolves.toEqual(winner.diff);
  });

  it("fails closed when the canonical envelope cache is malformed", async () => {
    const { sqlite, db } = createTestDatabase();
    sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, '{"schemaVersion":1}', SCHEDULED_FOR_SEC);

    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow();
  });
});
