import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { buildSafetyScoreV8PublicationIdentity } from "@shared/lib/safety-score-v8-publication";
import { createReportCardRawInputs } from "@shared/lib/report-card-raw-inputs";
import { DIMENSION_WEIGHTS, GRADE_THRESHOLDS, PEG_MULTIPLIER_EXPONENT } from "@shared/lib/report-cards";
import { ACTIVE_IDS } from "@shared/lib/stablecoins/registry";
import type { ReportCardsResponse } from "@shared/types/report-cards";
import { buildReportCardPublicationPlan } from "../report-card-publication";

const mockGetCache = vi.fn();
const mockSetCache = vi.fn();

vi.mock("../db-cache", () => ({
  getCache: mockGetCache,
  setCache: mockSetCache,
}));

const {
  REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
  REPORT_CARDS_SNAPSHOT_CACHE_MAX_STORED_BYTES,
  buildPublishedReportCardsSnapshotCacheEntry,
  loadPublishedReportCardsSnapshot,
  parsePublishedReportCardsSnapshotCacheValue,
} = await import("../report-cards-snapshot-cache");

function validSnapshot(largeDetail = "fixture"): ReportCardsResponse {
  const updatedAt = 1_700_000_000;
  const activeIds = [...ACTIVE_IDS].sort();
  const normalDimension = { grade: "A" as const, score: 90, detail: "fixture" };
  const cards = activeIds.map((id, index) => ({
    id,
    name: id,
    symbol: id,
    overallGrade: "A" as const,
    overallScore: 90,
    baseScore: 90,
    dimensions: {
      pegStability: index === 0 ? { ...normalDimension, detail: largeDetail } : normalDimension,
      liquidity: normalDimension,
      resilience: normalDimension,
      decentralization: normalDimension,
      dependencyRisk: normalDimension,
    },
    ratedDimensions: 5,
    rawInputs: createReportCardRawInputs(),
    isDefunct: false,
  }));
  const publication = buildReportCardPublicationPlan(cards, SAFETY_SCORE_METHODOLOGY_VERSION, updatedAt).completeness;
  const identity = buildSafetyScoreV8PublicationIdentity({
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
    baseInputGenerationId: `report-cards-input:v1:${"a".repeat(64)}`,
    publicationGenerationId: publication.generationId,
  });
  return {
    safetyScoreIdentity: identity,
    cards,
    methodology: {
      version: SAFETY_SCORE_METHODOLOGY_VERSION,
      weights: DIMENSION_WEIGHTS,
      pegMultiplierExponent: PEG_MULTIPLIER_EXPONENT,
      thresholds: GRADE_THRESHOLDS,
    },
    dependencyGraph: { edges: [] },
    updatedAt,
    publication,
  };
}

function structuredLargeDetail(minimumLength: number): string {
  const chains = ["ethereum", "arbitrum", "base", "solana", "polygon"];
  const sources = ["issuer-attestation", "dex-liquidity", "redemption", "dependency-graph"];
  const records: string[] = [];
  let length = 0;
  for (let index = 0; length < minimumLength; index += 1) {
    const record = [
      `asset=stablecoin-${index % 307}`,
      `chain=${chains[index % chains.length]}`,
      `source=${sources[index % sources.length]}`,
      `score=${(index * 37) % 101}`,
      `liquidityUsd=${1_000_000 + index * 97}`,
      `observedAt=${1_700_000_000 + index * 300}`,
      `evidenceRef=review-${index.toString(16).padStart(8, "0")}`,
    ].join("|");
    records.push(`${record}\n`);
    length += record.length + 1;
  }
  return records.join("").slice(0, minimumLength);
}

function deterministicOpaqueDetail(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  let state = 0x6d2b79f5;
  for (let index = 0; index < bytes.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

describe("report-cards snapshot cache", () => {
  beforeEach(() => {
    mockGetCache.mockReset();
    mockSetCache.mockReset();
  });

  it("rejects pre-live-dependency-generation envelopes", async () => {
    mockGetCache.mockResolvedValue({
      value: JSON.stringify({
        generation: 2,
        methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
        payload: {},
      }),
      updatedAt: 1_700_000_000,
    });

    await expect(loadPublishedReportCardsSnapshot({} as D1Database)).resolves.toEqual({
      kind: "error",
      reason: "generation-mismatch",
      updatedAt: 1_700_000_000,
    });
  });

  it("stores and round-trips a valid snapshot whose raw envelope exceeds the D1 row cap", async () => {
    const largeDetail = structuredLargeDetail(2_100_000);
    const snapshot = validSnapshot(largeDetail);
    const entry = await buildPublishedReportCardsSnapshotCacheEntry(snapshot);

    expect(entry.uncompressedBytes).toBeGreaterThan(2_000_000);
    expect(entry.storedBytes).toBeLessThanOrEqual(REPORT_CARDS_SNAPSHOT_CACHE_MAX_STORED_BYTES);
    expect(entry.storedBytes).toBeLessThan(2_000_000);
    const storageEnvelope = JSON.parse(entry.value) as Record<string, unknown>;
    expect(storageEnvelope).toMatchObject({
      storageSchemaVersion: 1,
      kind: "report-cards-snapshot",
      encoding: "gzip-base64",
      generation: REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
      model: "v8",
      identitySchemaVersion: 1,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      evaluationBuildDigest: SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST,
      baseInputGenerationId: snapshot.safetyScoreIdentity?.baseInputGenerationId,
      publicationGenerationId: snapshot.publication?.generationId,
      updatedAt: snapshot.updatedAt,
      uncompressedBytes: entry.uncompressedBytes,
    });

    const parsed = await parsePublishedReportCardsSnapshotCacheValue({
      value: entry.value,
      updatedAt: snapshot.updatedAt,
    });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.payload).toEqual(snapshot);
      expect(parsed.payload.cards[0]?.dimensions.pegStability.detail).toBe(largeDetail);
    }
  });

  it("rejects a deterministic opaque snapshot above the compressed storage budget", async () => {
    const snapshot = validSnapshot(deterministicOpaqueDetail(1_250_000));

    await expect(buildPublishedReportCardsSnapshotCacheEntry(snapshot)).rejects.toThrow(
      /Report-cards snapshot is \d+ compressed bytes; maximum is 1100000/,
    );
  });

  it("rejects checksum tampering and enforces the declared decompression bound", async () => {
    const snapshot = validSnapshot();
    const entry = await buildPublishedReportCardsSnapshotCacheEntry(snapshot);
    const checksumTampered = JSON.parse(entry.value) as Record<string, unknown>;
    checksumTampered.payloadSha256 = "0".repeat(64);

    await expect(
      parsePublishedReportCardsSnapshotCacheValue({
        value: JSON.stringify(checksumTampered),
        updatedAt: snapshot.updatedAt,
      }),
    ).resolves.toEqual({ kind: "error", reason: "checksum-mismatch", updatedAt: snapshot.updatedAt });

    const undersized = JSON.parse(entry.value) as Record<string, unknown>;
    undersized.uncompressedBytes = 1;
    await expect(
      parsePublishedReportCardsSnapshotCacheValue({
        value: JSON.stringify(undersized),
        updatedAt: snapshot.updatedAt,
      }),
    ).resolves.toEqual({ kind: "error", reason: "uncompressed-size-exceeded", updatedAt: snapshot.updatedAt });
  });

  it("rejects noncanonical base64 and non-gzip storage payloads", async () => {
    const snapshot = validSnapshot();
    const entry = await buildPublishedReportCardsSnapshotCacheEntry(snapshot);
    const noncanonicalBase64 = JSON.parse(entry.value) as Record<string, unknown>;
    noncanonicalBase64.payload = `${String(noncanonicalBase64.payload)}\n`;

    await expect(
      parsePublishedReportCardsSnapshotCacheValue({
        value: JSON.stringify(noncanonicalBase64),
        updatedAt: snapshot.updatedAt,
      }),
    ).resolves.toEqual({ kind: "error", reason: "decompression-failed", updatedAt: snapshot.updatedAt });

    const invalidGzip = JSON.parse(entry.value) as Record<string, unknown>;
    invalidGzip.payload = btoa("not-gzip");
    invalidGzip.compressedBytes = 8;
    await expect(
      parsePublishedReportCardsSnapshotCacheValue({
        value: JSON.stringify(invalidGzip),
        updatedAt: snapshot.updatedAt,
      }),
    ).resolves.toEqual({ kind: "error", reason: "decompression-failed", updatedAt: snapshot.updatedAt });
  });

  it("continues to read legacy plain generation-3 envelopes", async () => {
    const snapshot = validSnapshot("x".repeat(2_100_000));
    const legacyValue = JSON.stringify({
      generation: REPORT_CARDS_SNAPSHOT_CACHE_GENERATION,
      methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION,
      payload: snapshot,
    });
    expect(new TextEncoder().encode(legacyValue).byteLength).toBeGreaterThan(2_000_000);

    await expect(
      parsePublishedReportCardsSnapshotCacheValue({ value: legacyValue, updatedAt: snapshot.updatedAt }),
    ).resolves.toEqual({ kind: "ok", payload: snapshot, updatedAt: snapshot.updatedAt });
  });
});
