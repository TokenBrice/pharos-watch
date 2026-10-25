import { SAFETY_SCORE_COHORT_MAX_BYTES } from "@shared/types/safety-score-cohort";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeReportCardsV9Card } from "@shared/test-utils/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput, persistAndMaterialize } from "./safety-score-v9-publication-store.test-support";
import { loadSafetyScoreV9Publication, loadSafetyScoreV9PublicationIdentityEnvelope, persistSafetyScoreV9Publication } from "../safety-score-v9/publication-store";
import { SAFETY_SCORE_V9_CACHE_KEYS } from "../safety-score-v9/publication-health";
import { serializeSafetyScoreV9Publication } from "../safety-score-v9/publication-codec";
import {
  SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX,
  shardSafetyScoreV9CohortStoredValue,
  reassembleSafetyScoreV9CohortStoredValue,
  shardedSafetyScoreV9CohortChunkStatements,
  shardedSafetyScoreV9PublicationChunkStatements,
  safetyScoreV9PublicationChunkCleanupStatement,
  SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX,
  SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES,
  reassembleSafetyScoreV9PublicationFromCacheRows,
  reassembleSafetyScoreV9PublicationStoredValue,
  shardSafetyScoreV9PublicationStoredValue,
} from "../safety-score-v9/publication-chunks";
import { loadActiveSafetyScoreIndex } from "../safety-score-index";
import { loadSafetyPublicationSize } from "../status/safety-publication-size";
import { handleReportCardsV9 } from "../../api/report-cards-v9";
import { handleReportCardsV9Detail } from "../../api/report-cards-v9-projections";
import { materializeV9AcceptedPublication } from "../report-cards-v9-materialization";

const databases: DatabaseSync[] = [];
afterEach(() => { vi.useRealTimers(); for (const sqlite of databases.splice(0)) sqlite.close(); });
function database() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

// Large enough to need several chunks after compression.
function largePublication(generation: string, publishedAtSec: number) {
  return makeWorkerSafetyScoreV9Publication({
    publishedAtSec, publicationGenerationId: `report-cards:v9:${generation}`,
    cards: Array.from({ length: 40 }, (_, index) => {
      const card: SafetyScoreV9CurrentCard = makeReportCardsV9Card({ id: index === 39 ? "usdc-circle" : `chunk-coin-${String(index).padStart(2, "0")}` });
      card.witnessTexts = [Array.from({ length: 6_000 }, (_, word) => `${generation}-${index}-${word * 7919 % 104729}`).join(" ")];
      card.evidence.reasons = [{ code: "unresolved-control-identity", message: "~0", path: "control:incidentState" }];
      return card;
    }),
  });
}

/** What a sharding writer commits: chunk rows plus the sharded envelope in place of the inline row. */
function shardInPlace(sqlite: DatabaseSync) {
  const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!;
  const sharded = shardSafetyScoreV9PublicationStoredValue(row.value as string);
  for (const chunk of sharded.chunks) {
    sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)").run(chunk.key, chunk.value, row.updated_at);
  }
  sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(sharded.envelope, SAFETY_SCORE_V9_CACHE_KEYS.publication);
  return { inline: row.value as string, sharded };
}

describe("Safety Score V9 publication payload chunks", () => {
  it("round-trips the exact single-row stored value and rejects missing, reordered or altered chunks", async () => {
    const stored = await serializeSafetyScoreV9Publication(largePublication("roundtrip", 120));
    const sharded = shardSafetyScoreV9PublicationStoredValue(stored);
    expect(sharded.chunks.length).toBeGreaterThan(1);
    for (const chunk of sharded.chunks) expect(chunk.value.length).toBeLessThanOrEqual(SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES);
    expect(sharded.envelope.length).toBeLessThan(4_096);
    expect(JSON.parse(sharded.envelope)).not.toHaveProperty("payload");
    expect(reassembleSafetyScoreV9PublicationStoredValue(sharded.envelope, sharded.chunks)).toBe(stored);
    expect(reassembleSafetyScoreV9PublicationStoredValue(stored, [])).toBe(stored);
    expect(() => reassembleSafetyScoreV9PublicationStoredValue(sharded.envelope, sharded.chunks.slice(1))).toThrow(/payload chunks/);
    expect(() => reassembleSafetyScoreV9PublicationStoredValue(sharded.envelope, [...sharded.chunks].reverse())).toThrow(/out of order/);
    const altered = sharded.chunks.map((chunk, index) => index === 0 ? { ...chunk, value: `A${chunk.value.slice(1)}` } : chunk);
    expect(() => reassembleSafetyScoreV9PublicationStoredValue(sharded.envelope, altered)).toThrow(/digest mismatch/);
    const otherRows = [...sharded.chunks, { key: `${SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX}${"0".repeat(64)}:000`, value: "x" }];
    expect(reassembleSafetyScoreV9PublicationFromCacheRows(sharded.envelope, otherRows.reverse())).toBe(stored);
  });

  it("serves every reader from a sharded canonical row exactly as from the inline row", async () => {
    const { sqlite, db } = database();
    const publication = largePublication("current", 120);
    await persistAndMaterialize(db, currentInput(publication));
    const expectedFull = await (await handleReportCardsV9(db)).text();
    const detailUrl = new URL("https://example.com/api/report-cards/v9-detail?stablecoin=usdc-circle");
    const expectedDetail = await (await handleReportCardsV9Detail(db, detailUrl)).text();
    const expectedIndex = await loadActiveSafetyScoreIndex(db);
    const { inline, sharded } = shardInPlace(sqlite);
    const reassembled = await loadSafetyScoreV9Publication(db);
    expect(reassembled).toEqual(publication);
    expect((await loadSafetyScoreV9PublicationIdentityEnvelope(db))?.publicationGenerationId).toBe(publication.publicationGenerationId);
    expect(await loadActiveSafetyScoreIndex(db)).toEqual(expectedIndex);
    expect(await loadSafetyPublicationSize(db)).toMatchObject({ kind: "observed", storedBytes: new TextEncoder().encode(inline).byteLength });
    expect(await (await handleReportCardsV9(db)).text()).toBe(expectedFull);
    expect(await (await handleReportCardsV9Detail(db, detailUrl)).text()).toBe(expectedDetail);
    // Cold reads wait for heavy materialization; they never decode or write.
    sqlite.exec("DELETE FROM safety_score_site_manifests");
    const detail = await handleReportCardsV9Detail(db, detailUrl);
    expect(detail.status).toBe(503);
    expect(detail.headers.get("Cache-Control")).toBe("no-store");
    expect(await detail.json()).toMatchObject({ reason: "v9-public-materialization-pending" });
    expect(sqlite.prepare("SELECT count(*) AS n FROM safety_score_site_manifests").get()!.n).toBe(0);
    await materializeV9AcceptedPublication(db, { publication: reassembled!,
      health: currentInput(publication).publicationHealth, payloadSha256: JSON.parse(inline).payloadSha256 });
    const restoredDetail = await handleReportCardsV9Detail(db, detailUrl);
    expect(restoredDetail.status).toBe(200);
    expect(await restoredDetail.text()).toBe(expectedDetail);
    // A missing chunk fails closed instead of returning a partial payload.
    sqlite.prepare("DELETE FROM cache WHERE key = ?").run(sharded.chunks[sharded.chunks.length - 1]!.key);
    await expect(loadSafetyScoreV9Publication(db)).rejects.toThrow(/payload chunks/);
  });

  it("an inline acceptance after a sharded one removes stale chunks atomically", async () => {
    const { sqlite, db } = database();
    await persistAndMaterialize(db, currentInput(largePublication("first", 120)));
    shardInPlace(sqlite);
    const next = largePublication("next", 130);
    await persistAndMaterialize(db, currentInput(next));
    expect(sqlite.prepare("SELECT count(*) AS n FROM cache WHERE key LIKE ?").get(`${SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX}%`)!.n).toBe(0);
    expect(await loadSafetyScoreV9Publication(db)).toEqual(next);
  });
});

describe("Safety Score V9 sharded publication writer", () => {
  it.each([false, true])("commits chunks with the envelope and replaces the previous payload's chunks (deferred=%s)", async (deferred) => {
    const { sqlite, db } = database();
    const write = async (publication: ReturnType<typeof largePublication>) => {
      const input = { ...currentInput(publication), chunkedPublicationWrites: true };
      if (deferred) await persistAndMaterialize(db, input);
      else await persistSafetyScoreV9Publication(db, input);
    };
    const first = largePublication("first", 120);
    await write(first);
    const chunkKeys = () => sqlite.prepare("SELECT key FROM cache WHERE key LIKE ? ORDER BY key")
      .all(`${SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX}%`).map((row) => row.key as string);
    const firstKeys = chunkKeys();
    expect(firstKeys.length).toBeGreaterThan(1);
    const envelope = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_CACHE_KEYS.publication)!.value as string;
    expect(envelope.length).toBeLessThan(4_096);
    expect(await loadSafetyScoreV9Publication(db)).toEqual(first);
    expect((await handleReportCardsV9(db)).status).toBe(200);

    const next = largePublication("next", 130);
    await write(next);
    const nextKeys = chunkKeys();
    expect(nextKeys.length).toBeGreaterThan(1);
    expect(nextKeys.some((key) => firstKeys.includes(key))).toBe(false);
    expect(await loadSafetyScoreV9Publication(db)).toEqual(next);

    // A stale writer's batch rolls back its chunk writes with its envelope.
    await expect(persistSafetyScoreV9Publication(db, { ...currentInput(first), chunkedPublicationWrites: true })).rejects.toThrow();
    expect(chunkKeys()).toEqual(nextKeys);
  });
});


describe("Safety Score cohort payload chunks", () => {
  it("round-trips exact-cap ASCII and multi-byte JSON without splitting code points", () => {
    for (const value of [
      JSON.stringify("x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES - 2)),
      JSON.stringify("\u20ac".repeat(Math.floor((SAFETY_SCORE_COHORT_MAX_BYTES - 2) / 3))),
      JSON.stringify("\ud83d\udef0".repeat(Math.floor((SAFETY_SCORE_COHORT_MAX_BYTES - 2) / 4))),
    ]) {
      const sharded = shardSafetyScoreV9CohortStoredValue(value);
      expect(reassembleSafetyScoreV9CohortStoredValue(sharded.envelope, sharded.chunks)).toBe(value);
      expect(Buffer.byteLength(sharded.envelope)).toBeLessThan(512);
      expect(sharded.chunks.length).toBeGreaterThanOrEqual(8);
      expect(sharded.chunks.length).toBeLessThanOrEqual(9);
      for (const chunk of sharded.chunks) {
        expect(Buffer.byteLength(chunk.value)).toBeLessThanOrEqual(SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES);
        expect(chunk.value).not.toContain("\ufffd");
        expect(chunk.key.startsWith(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX)).toBe(true);
      }
    }
    expect(() => shardSafetyScoreV9CohortStoredValue(JSON.stringify("x".repeat(SAFETY_SCORE_COHORT_MAX_BYTES - 1)))).toThrow(/exceeds/);
  });

  it("retains a literal BOM at a chunk boundary", () => {
    const value = JSON.stringify(`${"x".repeat(SAFETY_SCORE_V9_PUBLICATION_CHUNK_MAX_BYTES - 1)}\ufefftail`);
    const sharded = shardSafetyScoreV9CohortStoredValue(value);
    expect(sharded.chunks[1]!.value.startsWith("\ufeff")).toBe(true);
    expect(reassembleSafetyScoreV9CohortStoredValue(sharded.envelope, sharded.chunks)).toBe(value);
  });

  it("rejects incomplete, reordered, corrupt, oversized and foreign-namespace chunks", () => {
    const sharded = shardSafetyScoreV9CohortStoredValue(JSON.stringify("x".repeat(600_000)));
    expect(() => reassembleSafetyScoreV9CohortStoredValue(sharded.envelope, sharded.chunks.slice(1))).toThrow(/payload chunks/);
    expect(() => reassembleSafetyScoreV9CohortStoredValue(sharded.envelope, [...sharded.chunks].reverse())).toThrow(/out of order/);
    const corrupt = sharded.chunks.map((chunk, index) => index === 0 ? { ...chunk, value: `y${chunk.value.slice(1)}` } : chunk);
    expect(() => reassembleSafetyScoreV9CohortStoredValue(sharded.envelope, corrupt)).toThrow(/digest mismatch/);
    const overCap = sharded.chunks.map((chunk, index) => index === 0 ? { ...chunk, value: `${chunk.value}x` } : chunk);
    expect(() => reassembleSafetyScoreV9CohortStoredValue(sharded.envelope, overCap)).toThrow(/byte length/);
    const foreign = sharded.chunks.map(chunk => ({ ...chunk, key: chunk.key.replace(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX, SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX) }));
    expect(() => reassembleSafetyScoreV9CohortStoredValue(sharded.envelope, foreign)).toThrow(/out of order/);
    expect(() => reassembleSafetyScoreV9CohortStoredValue(`${sharded.envelope} `, sharded.chunks)).toThrow(/canonical/);
    const envelope = JSON.parse(sharded.envelope);
    envelope.payloadChunks.payloadBytes = SAFETY_SCORE_COHORT_MAX_BYTES + 1;
    expect(() => reassembleSafetyScoreV9CohortStoredValue(stableJsonStringifyV1(envelope), sharded.chunks)).toThrow();
    envelope.payloadChunks.payloadBytes = 600_002;
    envelope.payloadSha256 = "f".repeat(64);
    expect(() => reassembleSafetyScoreV9CohortStoredValue(stableJsonStringifyV1(envelope), sharded.chunks)).toThrow(/coherent/);
  });

  it("isolates namespaces and rolls back chunk cleanup/writes with a failed envelope commit", async () => {
    const { sqlite, db } = database();
    const canonical = shardSafetyScoreV9PublicationStoredValue(JSON.stringify({ payload: "a".repeat(600_000), payloadSha256: "a".repeat(64) }));
    await db.batch(shardedSafetyScoreV9PublicationChunkStatements(db, canonical, "a".repeat(64), 110));
    const first = shardSafetyScoreV9CohortStoredValue(JSON.stringify("b".repeat(600_000)));
    const write = (sharded: typeof first, clock: number) => db.batch([
      ...shardedSafetyScoreV9CohortChunkStatements(db, sharded, clock),
      db.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
        .bind(SAFETY_SCORE_V9_CACHE_KEYS.cohort, sharded.envelope, clock),
    ]);
    await write(first, 110);
    const second = shardSafetyScoreV9CohortStoredValue(JSON.stringify("c".repeat(600_000)));
    await write(second, 120);
    const rows = () => sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all();
    const snapshot = rows();
    expect(snapshot.filter(row => String(row.key).startsWith(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX)).map(row => row.key))
      .toEqual(second.chunks.map(chunk => chunk.key));
    expect(snapshot.filter(row => String(row.key).startsWith(SAFETY_SCORE_V9_PUBLICATION_CHUNK_KEY_PREFIX))).toHaveLength(canonical.chunks.length);
    sqlite.exec(`CREATE TRIGGER reject_cohort BEFORE UPDATE ON cache WHEN NEW.key = '${SAFETY_SCORE_V9_CACHE_KEYS.cohort}' BEGIN SELECT RAISE(ABORT, 'failed cohort commit'); END`);
    await expect(write(first, 130)).rejects.toThrow(/failed cohort commit/);
    expect(rows()).toEqual(snapshot);
    await db.batch([safetyScoreV9PublicationChunkCleanupStatement(db)]);
    expect(rows().filter(row => String(row.key).startsWith(SAFETY_SCORE_V9_COHORT_CHUNK_KEY_PREFIX))).toHaveLength(second.chunks.length);
  });
});
