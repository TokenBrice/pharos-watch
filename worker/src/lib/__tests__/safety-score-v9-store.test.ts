import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { sha256Hex as legacySha256Hex } from "@shared/lib/sha256";
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
  type SafetyScoreV9ReplayArtifactKind,
} from "../safety-score-v9-shadow";
import {
  SAFETY_SCORE_V9_SHADOW_CACHE_KEYS,
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_COMPRESSED_BYTES,
  SAFETY_SCORE_V9_SHADOW_CACHE_MAX_STORED_BYTES,
  SafetyScoreV9StoreConflictError,
  buildSafetyScoreV9LocalArtifactBundle,
  buildSafetyScoreV9ReplayArtifact,
  getSafetyScoreV9LocalArtifactBundleArtifacts,
  getSafetyScoreV9LocalArtifactBundleReferences,
  loadLatestSafetyScoreV9DiffReport,
  loadLatestSafetyScoreV9ShadowEnvelope,
  loadSafetyScoreV9ReplayArtifact,
  loadSafetyScoreV9ShadowHistory,
  parseSafetyScoreV9ReplayArtifact,
  persistSafetyScoreV9ReplayArtifact,
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
    schemaVersion: 1,
    lifecycle: "candidate",
    candidateId: "candidate-v9-store-test",
    policyVersion: "candidate-v9-store-test",
    publicationGenerationId: "v9-shadow:test-generation",
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
    grade: "A",
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

const ARTIFACT_IDENTITIES: Record<SafetyScoreV9ReplayArtifactKind, string> = {
  "base-input": BASE_INPUT_GENERATION_ID,
  "fact-set": FACT_SET_DIGEST,
  policy: POLICY_DIGEST,
  "evaluation-build": EVALUATION_BUILD_DIGEST,
  result: RESULT_DIGEST,
};

const ARTIFACT_KINDS = ["base-input", "fact-set", "policy", "evaluation-build", "result"] as const;

function artifactInput(kind: SafetyScoreV9ReplayArtifactKind) {
  return {
    kind,
    identity: ARTIFACT_IDENTITIES[kind],
    value: { artifact: kind, version: 1 },
    createdAtSec: SCHEDULED_FOR_SEC + 21,
  };
}

async function buildArtifactSet(): Promise<SafetyScoreV9StoredReplayArtifact[]> {
  return Promise.all(ARTIFACT_KINDS.map((kind) => buildSafetyScoreV9ReplayArtifact(artifactInput(kind))));
}

function buildSuccessfulState(
  candidateValue: SafetyScoreV9Response,
  references: Awaited<ReturnType<typeof parseSafetyScoreV9ReplayArtifact>>["reference"][],
  artifactKeys: string[],
) {
  const envelope = buildSafetyScoreV9ShadowEnvelope({
    candidate: candidateValue,
    expectedActiveIds: candidateValue.cards.map((card) => card.id),
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
    archiveSelectionReasons: artifactKeys.length > 0 ? ["first"] : [],
    artifactKeys,
  });
  return { envelope, diff, daily };
}

async function successfulState(archived = false, candidateValue = candidate()) {
  const artifacts = archived ? await buildArtifactSet() : [];
  const references = await Promise.all(
    artifacts.map(async (artifact) => (await parseSafetyScoreV9ReplayArtifact(artifact)).reference),
  );
  return {
    artifacts,
    ...buildSuccessfulState(
      candidateValue,
      references,
      artifacts.map((artifact) => artifact.artifactKey),
    ),
  };
}

async function locallyBundledSuccessfulState(candidateValue = candidate()) {
  const localArtifactBundle = await buildSafetyScoreV9LocalArtifactBundle(ARTIFACT_KINDS.map(artifactInput));
  const artifacts = getSafetyScoreV9LocalArtifactBundleArtifacts(localArtifactBundle);
  return {
    localArtifactBundle,
    ...buildSuccessfulState(
      candidateValue,
      [...getSafetyScoreV9LocalArtifactBundleReferences(localArtifactBundle)],
      artifacts.map((artifact) => artifact.artifactKey),
    ),
  };
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

    const bomPayload = await gzipBase64Utf8(`\uFEFF${parsed.canonicalJson}`);
    const bomContentSha256 = legacySha256Hex(`\uFEFF${parsed.canonicalJson}`);
    await expect(
      parseSafetyScoreV9ReplayArtifact({
        ...artifact,
        artifactKey: `policy:${bomContentSha256}`,
        contentSha256: bomContentSha256,
        payload: bomPayload.payload,
        storedBytes: bomPayload.payload.length,
        uncompressedBytes: bomPayload.uncompressedBytes,
      }),
    ).rejects.toThrow("Malformed Safety Score v9 replay artifact JSON");
  });

  it("preserves a surrogate pair across the streaming UTF-8 chunk boundary", async () => {
    const canonicalPrefix = '{"padding":"';
    const padding = `${"a".repeat(65_535 - canonicalPrefix.length)}\u{1f600}tail`;
    const expectedCanonicalJson = stableJsonStringifyV1({ padding });
    expect(expectedCanonicalJson.charCodeAt(65_535)).toBeGreaterThanOrEqual(0xd800);
    expect(expectedCanonicalJson.charCodeAt(65_536)).toBeGreaterThanOrEqual(0xdc00);

    const artifact = await buildSafetyScoreV9ReplayArtifact({
      kind: "result",
      identity: RESULT_DIGEST,
      value: { padding },
      createdAtSec: SCHEDULED_FOR_SEC,
    });
    const parsed = await parseSafetyScoreV9ReplayArtifact<{ padding: string }>(artifact);

    expect(parsed.canonicalJson).toBe(expectedCanonicalJson);
    expect(parsed.value).toEqual({ padding });
    expect(artifact.uncompressedBytes).toBe(new TextEncoder().encode(expectedCanonicalJson).byteLength);

    const legacyPayload = await gzipBase64Utf8(expectedCanonicalJson);
    const legacyContentSha256 = legacySha256Hex(expectedCanonicalJson);
    const legacyArtifact: SafetyScoreV9StoredReplayArtifact = {
      ...artifact,
      artifactKey: `result:${legacyContentSha256}`,
      contentSha256: legacyContentSha256,
      payload: legacyPayload.payload,
      storedBytes: legacyPayload.payload.length,
      uncompressedBytes: legacyPayload.uncompressedBytes,
    };
    await expect(parseSafetyScoreV9ReplayArtifact(legacyArtifact)).resolves.toMatchObject({
      canonicalJson: expectedCanonicalJson,
      value: { padding },
    });
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

    await expect(
      buildSafetyScoreV9ReplayArtifact(
        {
          kind: "result",
          identity: RESULT_DIGEST,
          value: { padding: "\u00e9".repeat(100) },
          createdAtSec: SCHEDULED_FOR_SEC,
        },
        { maxUncompressedBytes: 150 },
      ),
    ).rejects.toThrow("maximum is 150");

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

  it("rejects an impossible stored payload before attempting base64 encoding", async () => {
    const originalBtoa = btoa;
    const encode = vi.fn(() => {
      throw new Error("unexpected base64 encoding");
    });
    vi.stubGlobal("btoa", encode);
    try {
      await expect(
        buildSafetyScoreV9ReplayArtifact(
          {
            kind: "result",
            identity: RESULT_DIGEST,
            value: { padding: "x".repeat(4_096) },
            createdAtSec: SCHEDULED_FOR_SEC,
          },
          { maxStoredBytes: 1 },
        ),
      ).rejects.toThrow("compressed byte limit");
      expect(encode).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("btoa", originalBtoa);
    }
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
  it("trusts only an immutable locally built artifact bundle and still verifies external artifacts", async () => {
    const localState = await locallyBundledSuccessfulState();
    const externalState = await successfulState(true);
    expect(Object.isFrozen(localState.localArtifactBundle)).toBe(true);
    expect(Object.getPrototypeOf(localState.localArtifactBundle)).toBeNull();
    expect(() =>
      Object.setPrototypeOf(localState.localArtifactBundle, {
        read: () => ({ artifacts: [], references: [] }),
      }),
    ).toThrow(TypeError);
    const { sqlite, db } = createTestDatabase();
    const originalDecompressionStream = DecompressionStream;
    vi.stubGlobal(
      "DecompressionStream",
      class {
        constructor() {
          throw new Error("unexpected replay artifact decompression");
        }
      },
    );

    try {
      await expect(persistSafetyScoreV9ShadowState(db, localState)).resolves.toBeUndefined();
      await expect(persistSafetyScoreV9ShadowState(db, localState)).resolves.toBeUndefined();
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_artifacts").get()).toEqual({ count: 5 });

      const storedBaseInput = sqlite
        .prepare("SELECT payload FROM safety_score_v9_artifacts WHERE artifact_kind = 'base-input'")
        .get() as { payload: string };
      const replacement = storedBaseInput.payload[0] === "A" ? "B" : "A";
      sqlite
        .prepare("UPDATE safety_score_v9_artifacts SET payload = ? WHERE artifact_kind = 'base-input'")
        .run(`${replacement}${storedBaseInput.payload.slice(1)}`);
      await expect(persistSafetyScoreV9ShadowState(db, localState)).rejects.toThrow(
        "unexpected replay artifact decompression",
      );

      const externalDb = createTestDatabase().db;
      await expect(persistSafetyScoreV9ShadowState(externalDb, externalState)).rejects.toThrow(
        "unexpected replay artifact decompression",
      );
    } finally {
      vi.stubGlobal("DecompressionStream", originalDecompressionStream);
    }

    const forgedBundle = structuredClone(localState.localArtifactBundle) as typeof localState.localArtifactBundle;
    const forgedState = { ...localState, localArtifactBundle: forgedBundle };
    await expect(persistSafetyScoreV9ShadowState(createTestDatabase().db, forgedState)).rejects.toThrow(
      "Invalid locally built Safety Score v9 artifact bundle",
    );
  });

  it("persists one compact daily row and atomic latest cache values without routine artifacts", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();

    await persistSafetyScoreV9ShadowState(db, state);

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
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM cache").get()).toEqual({ count: 2 });
    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(state.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(state.diff);
    await expect(loadSafetyScoreV9ShadowHistory(db)).resolves.toEqual([state.daily]);
  });

  it("round-trips a production-scale semantic envelope above the D1 value limit", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState(false, productionScaleCandidate());
    const semanticBytes = new TextEncoder().encode(stableJsonStringifyV1(state.envelope)).byteLength;
    expect(semanticBytes).toBeGreaterThan(2_000_000);

    await persistSafetyScoreV9ShadowState(db, state);

    const rows = sqlite.prepare("SELECT key, value FROM cache ORDER BY key").all() as Array<{
      key: string;
      value: string;
    }>;
    expect(rows).toHaveLength(2);
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

  it("continues to read legacy plain canonical latest values", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState();
    const insert = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
    insert.run(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, stableJsonStringifyV1(state.envelope), SCHEDULED_FOR_SEC);
    insert.run(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff, stableJsonStringifyV1(state.diff), SCHEDULED_FOR_SEC);

    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).resolves.toEqual(state.envelope);
    await expect(loadLatestSafetyScoreV9DiffReport(db)).resolves.toEqual(state.diff);
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

  it("increments a failed daily row on retry and retains selected archives only when requested", async () => {
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
    const state = await successfulState(true);
    state.daily = buildSafetyScoreV9ShadowDailySuccess({
      utcDay: "2023-11-14",
      selectedAtSec: SCHEDULED_FOR_SEC + 23,
      updatedAtSec: SCHEDULED_FOR_SEC + 24,
      previous: failure,
      envelope: state.envelope,
      diff: state.diff,
      archiveSelectionReasons: ["first"],
      artifactKeys: state.artifacts.map((artifact) => artifact.artifactKey),
    });
    await persistSafetyScoreV9ShadowState(db, state);

    expect(
      sqlite.prepare("SELECT successful_attempt_count, failed_attempt_count FROM safety_score_v9_shadow_daily").get(),
    ).toEqual({
      successful_attempt_count: 1,
      failed_attempt_count: 1,
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM safety_score_v9_artifacts").get()).toEqual({ count: 5 });
  });

  it("atomically re-selects a newer intra-day success and records later failures", async () => {
    const { sqlite, db } = createTestDatabase();
    const original = await successfulState();
    await persistSafetyScoreV9ShadowState(db, original);

    const refreshedCandidate = {
      ...candidate(),
      candidateId: "candidate-v9-store-refreshed",
      policyVersion: "candidate-v9-store-refreshed",
      publicationGenerationId: "v9-shadow:refreshed-generation",
      resultDigest: digest("8"),
    };
    const refreshed = await successfulState(false, refreshedCandidate);
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

  it("rolls back selected artifacts, daily state, and envelope when the atomic latest write fails", async () => {
    const { sqlite, db } = createTestDatabase();
    const state = await successfulState(true);
    sqlite.exec(`
      CREATE TRIGGER reject_v9_diff_cache
      BEFORE INSERT ON cache
      WHEN NEW.key = '${SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.diff}'
      BEGIN
        SELECT RAISE(ABORT, 'injected v9 diff cache failure');
      END;
    `);

    await expect(persistSafetyScoreV9ShadowState(db, state)).rejects.toThrow("injected v9 diff cache failure");
    for (const table of ["safety_score_v9_artifacts", "safety_score_v9_shadow_daily", "cache"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table).toEqual({ count: 0 });
    }
  });

  it("keeps the first selected success when another writer wins after preflight", async () => {
    const { sqlite, db } = createTestDatabase();
    const raceDb = createSqliteD1(sqlite);
    const loser = await successfulState();
    const winnerCandidate = {
      ...candidate(),
      candidateId: "candidate-v9-race-winner",
      policyVersion: "candidate-v9-race-winner",
      publicationGenerationId: "v9-shadow:race-winner",
      resultDigest: digest("8"),
    };
    const winner = await successfulState(false, winnerCandidate);
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
      const refreshed = await successfulState(false, {
        ...candidate(),
        candidateId: `candidate-v9-race-${label}`,
        policyVersion: `candidate-v9-race-${label}`,
        publicationGenerationId: `v9-shadow:race-${label}`,
        resultDigest: digest(label === "winner" ? "8" : "9"),
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

  it("fails closed when the latest envelope cache is malformed", async () => {
    const { sqlite, db } = createTestDatabase();
    sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(SAFETY_SCORE_V9_SHADOW_CACHE_KEYS.envelope, '{"schemaVersion":1}', SCHEDULED_FOR_SEC);

    await expect(loadLatestSafetyScoreV9ShadowEnvelope(db)).rejects.toThrow();
  });
});
