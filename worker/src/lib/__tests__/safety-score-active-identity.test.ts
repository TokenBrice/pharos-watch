import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SafetyScoreIndexSchema } from "@shared/types/safety-score-index";
import { V9PublicationHealthSchema } from "@shared/types/report-cards-v9";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import { currentInput } from "./safety-score-v9-publication-store.test-support";
import { persistSafetyScoreV9Publication, SAFETY_SCORE_V9_CACHE_KEYS } from "../safety-score-v9/publication-store";
import { loadActiveSafetyScoreIdentity } from "../safety-score-active-source";
import { loadActiveSafetyScoreIndex } from "../safety-score-index";
import { computeSafetyScoresSnapshot } from "../safety-scores";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

async function accepted() {
  const sqlite = createLatestSchemaSqlite().sqlite;
  databases.push(sqlite);
  const db = createSqliteD1(sqlite);
  const publication = makeWorkerSafetyScoreV9Publication();
  await persistSafetyScoreV9Publication(db, currentInput(publication));
  return { sqlite, db, publication };
}

function mutateRow<T>(sqlite: DatabaseSync, key: string, schema: z.ZodType<T>, mutate: (value: T) => void) {
  const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(key) as { value: string };
  const value = schema.parse(JSON.parse(row.value));
  mutate(value);
  sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?").run(stableJsonStringifyV1(value), key);
}

describe("generation-bound Safety Score index", () => {
  it("serves only the identity of the matching accepted publication", async () => {
    const { db, publication } = await accepted();
    const identity = await loadActiveSafetyScoreIdentity(db);
    expect(identity).toMatchObject({ kind: "v9", safetyScoreIdentity: {
      publicationGenerationId: publication.publicationGenerationId,
      policyDigest: publication.policy.semanticDigest,
    } });
    const scores = await computeSafetyScoresSnapshot(db);
    expect([...scores.scores]).toEqual(publication.cards.filter(card => card.score !== null)
      .map(card => [card.id, { score: card.score, grade: card.grade }]));
  });

  it("retains the accepted identity and ratings on a held attempt", async () => {
    const { db, publication } = await accepted();
    const input = currentInput(publication);
    await persistSafetyScoreV9Publication(db, {
      publicationClockSec: publication.publishedAtSec + 1,
      publicationHealth: { ...input.publicationHealth, status: "held", attemptedAtSec: publication.publishedAtSec + 1,
        heldSinceSec: publication.publishedAtSec + 1, reasons: [{ code: "dex-stale" }] },
      publicationAttempt: { ...input.publicationAttempt, outcome: "held", publicationGenerationId: null, attemptedAtSec: publication.publishedAtSec + 1 },
    });
    expect(await loadActiveSafetyScoreIdentity(db)).toMatchObject({ kind: "held", safetyScoreIdentity: {
      publicationGenerationId: publication.publicationGenerationId,
    } });
    expect(await computeSafetyScoresSnapshot(db)).toMatchObject({ kind: "degraded", reason: "v9-publication-held",
      publicationGenerationId: publication.publicationGenerationId, coveredCount: 1 });
  });

  it.each([
    ["generation", "safety-score-index-publication-mismatch"],
    ["digest", "safety-score-index-publication-mismatch"],
    ["health", "safety-score-index-health-mismatch"],
    ["missing", "safety-score-index-missing"],
    ["invalid", "safety-score-index-invalid"],
  ] as const)("rejects %s mismatch without ratings or a positive identity", async (failure, reason) => {
    const { sqlite, db } = await accepted();
    if (failure === "missing") sqlite.prepare("DELETE FROM cache WHERE key = ?").run(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    else if (failure === "health") mutateRow(sqlite, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth, V9PublicationHealthSchema,
      health => { health.acceptedPublicationGenerationId = "report-cards:v9:other"; });
    else mutateRow(sqlite, SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex, SafetyScoreIndexSchema, index => {
      if (failure === "generation") index.safetyScoreIdentity.publicationGenerationId = "report-cards:v9:other";
      if (failure === "digest") index.publicationResultDigest = "f".repeat(64);
      if (failure === "invalid") index.scores = {};
    });
    expect(await loadActiveSafetyScoreIndex(db)).toMatchObject({ kind: "error", reason, snapshot: null });
    expect(await loadActiveSafetyScoreIdentity(db)).toEqual({ kind: "error", safetyScoreIdentity: null });
    expect(await computeSafetyScoresSnapshot(db)).toMatchObject({ kind: "degraded", reason,
      scores: new Map(), safetyScoreIdentity: null, publishedAt: null });
  });

  it("rolls back the publication when the score-index write loses its fence", async () => {
    const { sqlite, db, publication } = await accepted();
    sqlite.prepare("UPDATE cache SET updated_at = ? WHERE key = ?").run(200, SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex);
    await expect(persistSafetyScoreV9Publication(db, currentInput(makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:new", publishedAtSec: 120,
    })))).rejects.toThrow();
    expect(sqlite.prepare("SELECT json_extract(value, '$.identity.publicationGenerationId') AS generation FROM cache WHERE key = ?")
      .get(SAFETY_SCORE_V9_CACHE_KEYS.publication)?.generation).toBe(publication.publicationGenerationId);
  });
});
