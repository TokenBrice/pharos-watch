import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import {
  loadSafetyScoreV9Publication,
  loadSafetyScoreV9PublicationAttempt,
  loadSafetyScoreV9FailedPublicationAttempt,
  loadSafetyScoreV9PublicationHealth,
  persistSafetyScoreV9Publication,
  persistSafetyScoreV9PublicationAttempt,
  SAFETY_SCORE_V9_CACHE_KEYS,
} from "../safety-score-v9-publication-store";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";

const databases: DatabaseSync[] = [];

function database(): {
  sqlite: DatabaseSync;
  db: D1Database;
} {
  const sqlite = createLatestSchemaSqlite().sqlite;
  databases.push(sqlite);
  return { sqlite, db: createSqliteD1(sqlite) };
}

afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

describe("Safety Score V9 publication store", () => {
  it("rejects a health advance when the publication row is already newer", async () => {
    const { db } = database();
    const newer = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 200 });
    const incoming = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 150 });
    const health = {
      schemaVersion: 1 as const,
      status: "current" as const,
      acceptedPublicationGenerationId: newer.publicationGenerationId,
      acceptedAtSec: newer.publishedAtSec,
      attemptedAtSec: newer.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    };
    await persistSafetyScoreV9Publication(db, {
      publication: newer,
      publicationHealth: health,
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: 200,
        outcome: "published-clean",
        publicationGenerationId: newer.publicationGenerationId,
        quarantines: [],
        affectedAssetIds: [],
      },
      publicationClockSec: 200,
    });
    await expect(persistSafetyScoreV9Publication(db, {
      publication: incoming,
      publicationHealth: {
        ...health,
        acceptedPublicationGenerationId: incoming.publicationGenerationId,
        acceptedAtSec: incoming.publishedAtSec,
        attemptedAtSec: incoming.publishedAtSec,
      },
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: 150,
        outcome: "published-clean",
        publicationGenerationId: incoming.publicationGenerationId,
        quarantines: [],
        affectedAssetIds: [],
      },
      publicationClockSec: 150,
    })).rejects.toThrow(/Stale or conflicting Safety Score v9 publication/);
  });

  it("publishes canonical ratings and advances held health without replacing them", async () => {
    const { sqlite, db } = database();
    const publication = makeWorkerSafetyScoreV9Publication({
      publishedAtSec: 110,
    });
    const currentHealth = {
      schemaVersion: 1 as const,
      status: "current" as const,
      acceptedPublicationGenerationId:
        publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec,
      attemptedAtSec: publication.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    };

    await persistSafetyScoreV9Publication(db, {
      publication,
      publicationHealth: currentHealth,
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: publication.publishedAtSec,
        outcome: "published-clean",
        publicationGenerationId:
          publication.publicationGenerationId,
        quarantines: [],
        affectedAssetIds: [],
      },
      publicationClockSec: publication.publishedAtSec,
    });
    await expect(loadSafetyScoreV9Publication(db)).resolves.toEqual(
      publication,
    );
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(
      currentHealth,
    );
    await expect(loadSafetyScoreV9PublicationAttempt(db)).resolves.toMatchObject(
      {
        outcome: "published-clean",
        publicationGenerationId:
          publication.publicationGenerationId,
      },
    );

    await persistSafetyScoreV9Publication(db, {
      publicationHealth: {
        ...currentHealth,
        status: "held",
        attemptedAtSec: 120,
        heldSinceSec: 120,
        reasons: [{ code: "dex-stale" }],
      },
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: 120,
        outcome: "held",
        publicationGenerationId: null,
        quarantines: [],
        affectedAssetIds: [],
      },
      publicationClockSec: 120,
    });

    await expect(loadSafetyScoreV9Publication(db)).resolves.toEqual(
      publication,
    );
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toMatchObject(
      {
        status: "held",
        attemptedAtSec: 120,
        acceptedPublicationGenerationId:
          publication.publicationGenerationId,
      },
    );
    expect(
      sqlite.prepare("SELECT key FROM cache ORDER BY key").all(),
    ).toEqual([
      { key: SAFETY_SCORE_V9_CACHE_KEYS.publication },
      { key: SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt },
      { key: SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth },
    ]);
  });

  it("records failed attempt metadata without replacing accepted attempt, publication, or health", async () => {
    const { db } = database();
    const publication = makeWorkerSafetyScoreV9Publication({
      publishedAtSec: 110,
    });
    const currentHealth = {
      schemaVersion: 1 as const,
      status: "current" as const,
      acceptedPublicationGenerationId:
        publication.publicationGenerationId,
      acceptedAtSec: publication.publishedAtSec,
      attemptedAtSec: publication.publishedAtSec,
      heldSinceSec: null,
      reasons: [],
    };

    await persistSafetyScoreV9Publication(db, {
      publication,
      publicationHealth: currentHealth,
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: publication.publishedAtSec,
        outcome: "published-partial",
        publicationGenerationId:
          publication.publicationGenerationId,
        quarantines: [],
        affectedAssetIds: ["usdc-circle"],
      },
      publicationClockSec: publication.publishedAtSec,
    });

    await persistSafetyScoreV9PublicationAttempt(db, {
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: 130,
        outcome: "failed",
        publicationGenerationId: null,
        quarantines: [],
        affectedAssetIds: [],
        failure: {
          stage: "compile",
          code: "safety-score-v9-publication-compile-Error",
          message: "compiler failed",
        },
      },
      publicationClockSec: 130,
    });

    await expect(loadSafetyScoreV9Publication(db)).resolves.toEqual(
      publication,
    );
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(
      currentHealth,
    );
    await expect(loadSafetyScoreV9PublicationAttempt(db)).resolves.toMatchObject(
      {
        outcome: "published-partial",
        publicationGenerationId:
          publication.publicationGenerationId,
        affectedAssetIds: ["usdc-circle"],
      },
    );
    await expect(
      loadSafetyScoreV9FailedPublicationAttempt(db),
    ).resolves.toMatchObject(
      {
        outcome: "failed",
        publicationGenerationId: null,
        failure: {
          stage: "compile",
          message: "compiler failed",
        },
      },
    );
  });
});
