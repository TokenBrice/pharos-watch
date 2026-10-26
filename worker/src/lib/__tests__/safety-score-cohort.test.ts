import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { SAFETY_SCORE_COHORT_MAX_BYTES, SafetyScoreCohortSchema } from "@shared/types/safety-score-cohort";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput } from "./safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_CACHE_KEYS as keys } from "../safety-score-v9/publication-health";
import { buildSafetyScoreV9AcceptedProjections, buildSafetyScoreV9CohortProjection, serializeSafetyScoreV9CohortProjection } from "../safety-score-v9/accepted-projections";
import { loadActiveSafetyScoreIndex } from "../safety-score-index";
import { loadActiveSafetyScoreCohort } from "../safety-score-active-source";
import * as publicCache from "../report-cards-v9-cache";
import * as structuredLog from "../structured-log";
import { SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, reassembleSafetyScoreV9CohortStoredValue, shardSafetyScoreV9CohortStoredValue } from "../safety-score-v9/publication-chunks";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => { fixtures.closeAll(); vi.restoreAllMocks(); });

async function fixture() {
  const fixture = fixtures.open();
  const publication = makeWorkerSafetyScoreV9Publication();
  await persistSafetyScoreV9Publication(fixture.db, { ...currentInput(publication), deferPublicMaterialization: true });
  const read = (key: string) => {
    const value = fixture.sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key)!.value as string;
    const chunks = fixture.sqlite.prepare("SELECT key, value FROM cache WHERE key >= ? AND key < ? ORDER BY key")
      .all(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`) as { key: string; value: string }[];
    return JSON.parse(key === keys.cohort ? reassembleSafetyScoreV9CohortStoredValue(value, chunks) : value);
  };
  const write = (key: string, value: unknown) => {
    let stored = stableJsonStringifyV1(value);
    if (key === keys.cohort) {
      const sharded = shardSafetyScoreV9CohortStoredValue(stored);
      stored = sharded.envelope;
      fixture.sqlite.prepare("DELETE FROM cache WHERE key >= ? AND key < ?")
        .run(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
      for (const chunk of sharded.chunks) fixture.sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
        .run(chunk.key, chunk.value, publication.publishedAtSec);
    }
    fixture.sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stored, key);
  };
  return { ...fixture, publication, read, write };
}

describe("accepted Safety Score cohort", () => {
  it.each(["current", "held"])("reads %s without decoding the publication", async status => {
    const { db, read, write, publication } = await fixture();
    const envelope = read(keys.publication);
    envelope.payload = "not-base64";
    write(keys.publication, envelope);
    if (status === "held") {
      const health = read(keys.publicationHealth);
      Object.assign(health, { status, heldSinceSec: health.attemptedAtSec, reasons: [{ code: "dex-stale" }] });
      write(keys.publicationHealth, health);
    }
    const prepare = vi.spyOn(db, "prepare");
    const result = await loadActiveSafetyScoreCohort(db);
    expect(result).toMatchObject({ kind: status === "current" ? "v9" : "held",
      snapshot: { updatedAt: publication.publishedAtSec, completeness: publication.completeness } });
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(prepare.mock.calls[0]![0]).not.toMatch(/p\.value\s+AS/);
  });

  it("shares the index schema-cutover reason without falling back", async () => {
    const { db, read, write } = await fixture();
    write(keys.scoreIndex, { ...read(keys.scoreIndex), schemaVersion: 1 });
    expect(await loadActiveSafetyScoreIndex(db)).toMatchObject({ kind: "error", reason: "publication-schema-cutover-pending" });
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "error", reason: "publication-schema-cutover-pending",
      snapshot: null });
  });

  it.each(["missing", "other-generation"])("rejects a %s cohort without decoding the publication", async scenario => {
    const { db, sqlite, read, write } = await fixture();
    if (scenario === "missing") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(keys.cohort);
    else {
      const cohort = read(keys.cohort);
      cohort.safetyScoreIdentity.publicationGenerationId = "report-cards:v9:prior";
      write(keys.cohort, cohort);
    }
    const fullRead = vi.spyOn(publicCache, "loadPublishedReportCardsV9Snapshot");
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "error", snapshot: null,
      reason: scenario === "missing" ? "safety-cohort-missing" : "safety-cohort-publication-mismatch" });
    expect(fullRead).not.toHaveBeenCalled();
  });

  it("warns when only the cohort crosses its half-cap and rejects overflow before any persistence", async () => {
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.cards[0]!.sharedBookId = "x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES / 2);
    const logger = vi.spyOn(structuredLog, "logWorkerEvent");
    const projections = buildSafetyScoreV9AcceptedProjections(publication);
    expect(logger).toHaveBeenCalledWith(expect.objectContaining({
      event: "safety_score_v9_accepted_projection_size_warning",
      metadata: expect.objectContaining({ cohortBytes: Buffer.byteLength(projections.cohort), cohortMaxBytes: SAFETY_SCORE_COHORT_MAX_BYTES }),
    }));
    publication.cards[0]!.sharedBookId = "x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES);
    const { db } = fixtures.open();
    const batch = vi.spyOn(db, "batch");
    await expect(persistSafetyScoreV9Publication(db, currentInput(publication))).rejects.toThrow(/exceeds/);
    expect(batch).not.toHaveBeenCalled();
  });

  it.each(["malformed", "canonical", "clock", "digest", "identity", "count", "missing-health", "health-generation", "missing-chunk", "corrupt-chunk", "missing-index", "index-generation"])(
    "fails closed without decode fallback for %s", async scenario => {
      const { db, sqlite, read, write } = await fixture();
      const cohort = read(keys.cohort);
      if (scenario === "malformed") sqlite.prepare("UPDATE cache SET value = '{' WHERE key = ?").run(keys.cohort);
      if (scenario === "canonical") sqlite.prepare("UPDATE cache SET value = value || ' ' WHERE key = ?").run(keys.cohort);
      if (scenario === "clock") sqlite.prepare("UPDATE cache SET updated_at = updated_at + 1 WHERE key = ?").run(keys.cohort);
      if (scenario === "digest") { cohort.publicationResultDigest = "f".repeat(64); write(keys.cohort, cohort); }
      if (scenario === "identity") { cohort.safetyScoreIdentity.policyDigest = "f".repeat(64); write(keys.cohort, cohort); }
      if (scenario === "count") { cohort.cards = []; write(keys.cohort, cohort); }
      if (scenario === "missing-health") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(keys.publicationHealth);
      if (scenario === "health-generation") { const health = read(keys.publicationHealth); health.acceptedPublicationGenerationId = "other"; write(keys.publicationHealth, health); }
      if (scenario === "missing-index") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(keys.scoreIndex);
      if (scenario === "index-generation") { const index = read(keys.scoreIndex); index.safetyScoreIdentity.publicationGenerationId = "other"; write(keys.scoreIndex, index); }
      if (scenario === "missing-chunk") sqlite.prepare("DELETE FROM cache WHERE key >= ? AND key < ?")
        .run(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
      if (scenario === "corrupt-chunk") sqlite.prepare("UPDATE cache SET value = 'corrupted' WHERE key >= ? AND key < ?")
        .run(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
      const prepare = vi.spyOn(db, "prepare");
      const result = await loadActiveSafetyScoreCohort(db);
      expect(result).toMatchObject({ kind: "error", snapshot: null });
      expect(result.kind === "error" && result.reason).toMatch(/^safety-cohort-/);
      expect(prepare).toHaveBeenCalledTimes(2);
    },
  );

  it("admits a cohort above D1's row ceiling using bounded chunks in the acceptance batch", async () => {
    const { db, sqlite } = fixtures.open();
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.cards[0]!.sharedBookId = "x".repeat(2_100_000);
    await persistSafetyScoreV9Publication(db, { ...currentInput(publication), deferPublicMaterialization: true });
    const chunks = sqlite.prepare("SELECT key, value FROM cache WHERE key >= ? AND key < ? ORDER BY key")
      .all(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, `${SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX.slice(0, -1)};`);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((chunk) => Buffer.byteLength(String(chunk.value)) <= 512 * 1024)).toBe(true);
    const batch = vi.spyOn(db, "batch");
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "v9",
      snapshot: { cards: [{ sharedBookId: publication.cards[0]!.sharedBookId }] } });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![0]).toHaveLength(2);
    const [metadata, chunkRows] = await batch.mock.results[0]!.value;
    expect(metadata.results).toHaveLength(1);
    expect(metadata.results[0]).toHaveProperty("score_index");
    expect(chunkRows.results).toHaveLength(chunks.length);
    for (const row of chunkRows.results) expect(Object.keys(row).sort()).toEqual(["chunk", "chunk_key"]);
  });

  it("preserves the index health-clock hold semantics and empty database unavailability", async () => {
    expect(await loadActiveSafetyScoreCohort(fixtures.open().db)).toMatchObject({ kind: "error", reason: "v9-snapshot-unavailable" });
    const { db, read, write } = await fixture();
    const health = read(keys.publicationHealth);
    health.acceptedAtSec--;
    write(keys.publicationHealth, health);
    expect(await loadActiveSafetyScoreCohort(db)).toMatchObject({ kind: "held" });
  });

  it("rejects oversize writes, rather than truncating the accepted projection", () => {
    const cohort = buildSafetyScoreV9CohortProjection(makeWorkerSafetyScoreV9Publication());
    cohort.cards[0]!.sharedBookId = "x";
    const initial = serializeSafetyScoreV9CohortProjection(cohort);
    cohort.cards[0]!.sharedBookId = "x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES - Buffer.byteLength(initial) + 1);
    const exact = serializeSafetyScoreV9CohortProjection(cohort);
    expect(Buffer.byteLength(exact)).toBe(SAFETY_SCORE_COHORT_MAX_BYTES);
    cohort.cards[0]!.sharedBookId += "x";
    expect(() => serializeSafetyScoreV9CohortProjection(cohort)).toThrow(/exceeds/);
    expect(SafetyScoreCohortSchema.safeParse({ ...cohort, cards: [cohort.cards[0], cohort.cards[0]] }).success).toBe(false);
  });
});
