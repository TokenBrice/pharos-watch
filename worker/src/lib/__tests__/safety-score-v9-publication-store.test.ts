import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { makeWorkerSafetyScoreV9Publication } from "../../test-helpers/report-cards-v9";
import {
  loadSafetyScoreV9Publication,
  loadSafetyScoreV9PublicationAttempt,
  loadSafetyScoreV9PublicationIdentityEnvelope,
  loadSafetyScoreV9FailedPublicationAttempt,
  loadSafetyScoreV9PublicationHealth,
  persistSafetyScoreV9Publication,
  persistSafetyScoreV9PublicationAttempt,
  SAFETY_SCORE_V9_CACHE_KEYS,
} from "../safety-score-v9/publication-store";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { currentInput } from "./safety-score-v9-publication-store.test-support";

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
    const { sqlite, db } = database();
    const older = makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:older",
      publishedAtSec: 100,
    });
    const newer = makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:newer",
      publishedAtSec: 200,
    });
    const incoming = makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:incoming",
      publishedAtSec: 150,
    });
    const olderHealth = currentInput(older).publicationHealth;
    await persistSafetyScoreV9Publication(db, currentInput(older));
    const olderHealthRow = sqlite
      .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
      .get(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth) as {
        value: string;
        updated_at: number;
      };
    await persistSafetyScoreV9Publication(db, currentInput(newer));
    sqlite
      .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
      .run(
        olderHealthRow.value,
        olderHealthRow.updated_at,
        SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
      );
    await expect(persistSafetyScoreV9Publication(db, currentInput(incoming)))
      .rejects.toThrow(/Stale or conflicting Safety Score v9 publication/);
    await expect(loadSafetyScoreV9Publication(db)).resolves.toEqual(newer);
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(
      olderHealth,
    );
    await expect(loadSafetyScoreV9PublicationAttempt(db)).resolves.toMatchObject({
      attemptedAtSec: 200,
      publicationGenerationId: newer.publicationGenerationId,
    });
  });

  it("rejects held health that loses the retained publication identity", async () => {
    const { db } = database();
    const publication = makeWorkerSafetyScoreV9Publication({
      publishedAtSec: 110,
    });
    const currentHealth = currentInput(publication).publicationHealth;
    await persistSafetyScoreV9Publication(db, currentInput(publication));

    await expect(persistSafetyScoreV9Publication(db, {
      publicationHealth: {
        schemaVersion: 1,
        status: "held",
        acceptedPublicationGenerationId: null,
        acceptedAtSec: null,
        attemptedAtSec: 120,
        heldSinceSec: 120,
        reasons: [{ code: "assessment-failed", detail: "read failed" }],
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
    })).rejects.toThrow(/does not match the stored publication/);
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(
      currentHealth,
    );
  });

  it("requires per-fact disclosure paths on post-9.19 writes", async () => {
    const { db } = database();
    const publication = makeWorkerSafetyScoreV9Publication({
      policyVersion: "9.19",
      publishedAtSec: 110,
    });
    const trace = publication.cards[0]!.scoreTrace as {
      evidenceResponsibility: { facts?: unknown };
    };
    delete trace.evidenceResponsibility.facts;

    await expect(persistSafetyScoreV9Publication(db, currentInput(publication)))
      .rejects.toThrow(/v9\.19\+ publications require per-fact disclosure paths/);
  });

  it("replaces an older publication that the current reader cannot parse", async () => {
    const { sqlite, db } = database();
    const older = makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:older",
      publishedAtSec: 100,
    });
    await persistSafetyScoreV9Publication(db, currentInput(older));
    sqlite
      .prepare("UPDATE cache SET value = ? WHERE key = ?")
      .run(
        "{\"legacy\":true}",
        SAFETY_SCORE_V9_CACHE_KEYS.publication,
      );
    await expect(loadSafetyScoreV9Publication(db)).rejects.toThrow();

    const replacement = makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:replacement",
      publishedAtSec: 110,
    });
    await persistSafetyScoreV9Publication(db, currentInput(replacement));

    await expect(loadSafetyScoreV9Publication(db)).resolves.toEqual(
      replacement,
    );
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toMatchObject({
      status: "current",
      acceptedPublicationGenerationId: replacement.publicationGenerationId,
    });
  });

  it("supports the initial held bootstrap before a publication exists", async () => {
    const { db } = database();
    const health = {
      schemaVersion: 1 as const,
      status: "held" as const,
      acceptedPublicationGenerationId: null,
      acceptedAtSec: null,
      attemptedAtSec: 100,
      heldSinceSec: 100,
      reasons: [{ code: "dex-stale" as const }],
    };

    await persistSafetyScoreV9Publication(db, {
      publicationHealth: health,
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: 100,
        outcome: "held",
        publicationGenerationId: null,
        quarantines: [],
        affectedAssetIds: [],
      },
      publicationClockSec: 100,
    });

    await expect(loadSafetyScoreV9Publication(db)).resolves.toBeNull();
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(
      health,
    );
  });

  it("rolls back a held attempt when a newer publication wins the race", async () => {
    const { sqlite, db } = database();
    const older = makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:older",
      publishedAtSec: 100,
    });
    const newer = makeWorkerSafetyScoreV9Publication({
      publicationGenerationId: "report-cards:v9:newer",
      publishedAtSec: 200,
    });
    await persistSafetyScoreV9Publication(db, currentInput(older));
    const olderRows = sqlite
      .prepare("SELECT key, value, updated_at FROM cache ORDER BY key")
      .all() as Array<{ key: string; value: string; updated_at: number }>;
    await persistSafetyScoreV9Publication(db, currentInput(newer));
    const newerRows = sqlite
      .prepare("SELECT key, value, updated_at FROM cache ORDER BY key")
      .all() as Array<{ key: string; value: string; updated_at: number }>;
    for (const row of olderRows) {
      sqlite
        .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
        .run(row.value, row.updated_at, row.key);
    }

    let raced = false;
    const racingDb = {
      ...db,
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          for (const row of newerRows) {
            sqlite
              .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
              .run(row.value, row.updated_at, row.key);
          }
        }
        return db.batch<T>(statements);
      },
    } as D1Database;

    await expect(persistSafetyScoreV9Publication(racingDb, {
      publicationHealth: {
        schemaVersion: 1,
        status: "held",
        acceptedPublicationGenerationId: older.publicationGenerationId,
        acceptedAtSec: older.publishedAtSec,
        attemptedAtSec: 300,
        heldSinceSec: 300,
        reasons: [{ code: "dex-stale" }],
      },
      publicationAttempt: {
        schemaVersion: 1,
        attemptedAtSec: 300,
        outcome: "held",
        publicationGenerationId: null,
        quarantines: [],
        affectedAssetIds: [],
      },
      publicationClockSec: 300,
    })).rejects.toThrow();
    await expect(loadSafetyScoreV9Publication(db)).resolves.toEqual(newer);
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toMatchObject({
      status: "current",
      acceptedPublicationGenerationId: newer.publicationGenerationId,
      attemptedAtSec: newer.publishedAtSec,
    });
    await expect(loadSafetyScoreV9PublicationAttempt(db)).resolves.toMatchObject({
      outcome: "published-clean",
      publicationGenerationId: newer.publicationGenerationId,
      attemptedAtSec: newer.publishedAtSec,
    });
  });

  it("publishes canonical ratings and advances held health without replacing them", async () => {
    const { sqlite, db } = database();
    const publication = makeWorkerSafetyScoreV9Publication({
      publishedAtSec: 110,
    });
    const currentHealth = currentInput(publication).publicationHealth;
    await persistSafetyScoreV9Publication(db, currentInput(publication));
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

  it("reads the publication identity from the storage envelope without the body", async () => {
    const { sqlite, db } = database();
    await expect(loadSafetyScoreV9PublicationIdentityEnvelope(db)).resolves.toBeNull();

    const publication = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 110 });
    await persistSafetyScoreV9Publication(db, currentInput(publication));

    await expect(loadSafetyScoreV9PublicationIdentityEnvelope(db)).resolves.toMatchObject({
      model: "v9",
      methodologyVersion: publication.policyVersion,
      policyId: publication.policy.id,
      publicationGenerationId: publication.publicationGenerationId,
    });

    // A tampered envelope identity reads as absent rather than throwing into a
    // polled monitor.
    sqlite
      .prepare("UPDATE cache SET value = json_set(value, '$.identity', json('{\"policyId\":1}')) WHERE key = ?")
      .run(SAFETY_SCORE_V9_CACHE_KEYS.publication);
    await expect(loadSafetyScoreV9PublicationIdentityEnvelope(db)).resolves.toBeNull();
  });

  it("records failed attempt metadata without replacing accepted attempt, publication, or health", async () => {
    const { db } = database();
    const publication = makeWorkerSafetyScoreV9Publication({
      publishedAtSec: 110,
    });
    const input = currentInput(publication);
    const currentHealth = input.publicationHealth;
    await persistSafetyScoreV9Publication(db, {
      ...input,
      publicationAttempt: {
        ...input.publicationAttempt,
        outcome: "published-partial",
        affectedAssetIds: ["usdc-circle"],
      },
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
