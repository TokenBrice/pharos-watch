import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { bytesToBase64 } from "@shared/lib/base64";
import { SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY, SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY } from "../safety-score-v9/publication-codec";
import { handleReportCardsV9 } from "../../api/report-cards-v9";
import {
  buildSafetyScoreV9AcceptedProjections,
  parseSafetyScoreV9AcceptedBaselineProjection,
  parseSafetyScoreV9LenderCollateralProjection,
} from "../safety-score-v9/accepted-projections";

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
  it("derives the index and both read models from the same immutable normalized publication", async () => {
    const { sqlite, db } = database();
    const publication = makeWorkerSafetyScoreV9Publication();
    publication.cards[0]!.pillars.backing.supportedComponentKeys = ["z", "a"];
    let admitted: typeof publication | undefined;
    await persistSafetyScoreV9Publication(db, {
      ...currentInput(publication),
      buildAcceptedProjections: value => {
        expect(Object.isFrozen(value.cards[0]!.pillars.backing)).toBe(true);
        expect(value.cards[0]!.pillars.backing.supportedComponentKeys).toEqual(["a", "z"]);
        admitted = value;
        return buildSafetyScoreV9AcceptedProjections(value);
      },
    });
    const read = (key: string) => {
      const row = sqlite.prepare("SELECT value, updated_at FROM cache WHERE key = ?").get(key) as { value: string; updated_at: number };
      return { value: row.value, updatedAt: row.updated_at };
    };
    expect(await loadSafetyScoreV9Publication(db)).toEqual(admitted);
    const baseline = parseSafetyScoreV9AcceptedBaselineProjection(read(SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline));
    const lender = parseSafetyScoreV9LenderCollateralProjection(read(SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral));
    expect(baseline.safetyScoreIdentity).toEqual(lender.safetyScoreIdentity);
    expect(baseline.publicationResultDigest).toBe(admitted!.resultDigest);
    expect(lender.publicationResultDigest).toBe(admitted!.resultDigest);
    const index = JSON.parse(read(SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex).value);
    expect(index.safetyScoreIdentity).toEqual(baseline.safetyScoreIdentity);
    expect(index.scores[admitted!.cards[0]!.id]).toMatchObject({
      score: admitted!.cards[0]!.score, grade: admitted!.cards[0]!.grade,
    });
    expect(publication.cards[0]!.pillars.backing.supportedComponentKeys).toEqual(["z", "a"]);
    expect(Object.isFrozen(publication.cards[0])).toBe(false);
  });

  it.each(["acceptedBaseline", "lenderCollateral", "publicationAttempt"] as const)(
    "rolls back every accepted row and replay transport when %s fails its constraint", async field => {
      const { sqlite, db } = database();
      const prior = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 110 });
      await persistSafetyScoreV9Publication(db, { ...currentInput(prior),
        publicationReplayBaseValue: "prior-base", publicationReplayCaptureValue: "prior-delta" });
      const before = sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all();
      sqlite.exec(`CREATE TRIGGER reject_projection BEFORE UPDATE ON cache
        WHEN NEW.key = '${SAFETY_SCORE_V9_CACHE_KEYS[field]}' BEGIN SELECT RAISE(ABORT, 'forced constraint failure'); END`);
      const next = makeWorkerSafetyScoreV9Publication({
        publicationGenerationId: "report-cards:v9:next", publishedAtSec: 120,
      });
      await expect(persistSafetyScoreV9Publication(db, { ...currentInput(next),
        publicationReplayBaseValue: "next-base", publicationReplayCaptureValue: "next-delta" })).rejects.toThrow();
      expect(sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all()).toEqual(before);
    },
  );

  it.each(["baseline", "lender"] as const)("fences equal-clock conflicting %s projection bytes but allows identical acceptance", async field => {
    const { sqlite, db } = database();
    const publication = makeWorkerSafetyScoreV9Publication();
    const input = { ...currentInput(publication), publicationReplayBaseValue: "base", publicationReplayCaptureValue: "delta" };
    await persistSafetyScoreV9Publication(db, input);
    const before = sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all();
    await persistSafetyScoreV9Publication(db, input);
    expect(sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all()).toEqual(before);
    await expect(persistSafetyScoreV9Publication(db, { ...input, buildAcceptedProjections: value => {
      const projections = buildSafetyScoreV9AcceptedProjections(value);
      return { ...projections, [field]: projections[field] + " " };
    } })).rejects.toThrow();
    expect(sqlite.prepare("SELECT key, value, updated_at FROM cache ORDER BY key").all()).toEqual(before);
  });

  it("rejects projection construction failure before committing any accepted row", async () => {
    const { sqlite, db } = database();
    await expect(persistSafetyScoreV9Publication(db, {
      ...currentInput(makeWorkerSafetyScoreV9Publication()),
      buildAcceptedProjections: () => { throw new Error("projection admission failed"); },
    })).rejects.toThrow("projection admission failed");
    expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([]);
  });

  it.each(["card", "legacy-schema", "unsupported-schema", "chronology", "membership", "foreign-gap", "parent", "health-clock"] as const)(
    "refuses invalid %s before any accepted D1 write", async scenario => {
      const { sqlite, db } = database();
      const publication = makeWorkerSafetyScoreV9Publication();
      if (scenario === "card") publication.cards[0]!.scoreTrace.evidenceResponsibility.totalFactCount = -1;
      if (scenario === "legacy-schema") Object.assign(publication, { schemaVersion: 6 });
      if (scenario === "unsupported-schema") Object.assign(publication, { schemaVersion: 8 });
      if (scenario === "chronology") publication.asOfSec = publication.publishedAtSec + 1;
      if (scenario === "membership") publication.cards.push(structuredClone(publication.cards[0]!));
      if (scenario === "foreign-gap") publication.cards[0]!.foreignCauseGapRefs = [0];
      if (scenario === "parent") publication.cards[0]!.dependencies.serial = [{
        upstreamAssetId: publication.cards[0]!.id, score: null, blocked: false, ratingStatus: "pipeline-gap", partialEvidence: null,
      }];
      const input = currentInput(publication);
      if (scenario === "health-clock") input.publicationHealth.acceptedAtSec = publication.publishedAtSec + 1;
      await expect(persistSafetyScoreV9Publication(db, input)).rejects.toThrow();
      expect(sqlite.prepare("SELECT key FROM cache").all()).toEqual([]);
    },
  );

  it.each(["publicationReplayCaptureValue", "publicationReplayBaseValue"] as const)("rejects a torn accepted replay pair with only %s", async field => {
    const { db } = database();
    const publication = makeWorkerSafetyScoreV9Publication();
    await expect(persistSafetyScoreV9Publication(db, { ...currentInput(publication), [field]: "unpaired" }))
      .rejects.toThrow("both base and delta or neither");
    await expect(loadSafetyScoreV9Publication(db)).resolves.toBeNull();
  });
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
    await persistSafetyScoreV9Publication(db, {
      ...currentInput(newer),
      publicationReplayCaptureValue: "accepted-delta",
      publicationReplayBaseValue: "accepted-base",
    });
    sqlite
      .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
      .run(
        olderHealthRow.value,
        olderHealthRow.updated_at,
        SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
      );
    await expect(persistSafetyScoreV9Publication(db, {
      ...currentInput(incoming),
      publicationReplayCaptureValue: "stale-delta",
      publicationReplayBaseValue: "stale-base",
    }))
      .rejects.toThrow(/Stale or conflicting Safety Score v9 publication/);
    await expect(loadSafetyScoreV9Publication(db)).resolves.toEqual(newer);
    await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(
      olderHealth,
    );
    await expect(loadSafetyScoreV9PublicationAttempt(db)).resolves.toMatchObject({
      attemptedAtSec: 200,
      publicationGenerationId: newer.publicationGenerationId,
    });
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY)?.value).toBe("accepted-delta");
    expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?").get(SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY)?.value).toBe("accepted-base");
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
        schemaVersion: 2,
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

  it("rejects current publication writes missing per-fact disclosure paths", async () => {
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
      .rejects.toMatchObject({ issues: expect.arrayContaining([
        expect.objectContaining({ path: ["cards", 0, "scoreTrace", "evidenceResponsibility", "facts"] }),
      ]) });
    await expect(loadSafetyScoreV9Publication(db)).resolves.toBeNull();
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
      schemaVersion: 2 as const,
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

  it.each(["dex-stale", "coverage-floor-failed", "assessment-failed"] as const)(
    "persists a first held %s over schema-1 health without exposing the retired publication",
    async code => {
      const { sqlite, db } = database();
      const publication = makeWorkerSafetyScoreV9Publication({ publishedAtSec: 100 });
      await persistSafetyScoreV9Publication(db, currentInput(publication));
      const row = sqlite.prepare("SELECT value FROM cache WHERE key = ?")
        .get(SAFETY_SCORE_V9_CACHE_KEYS.publication) as { value: string };
      const payload = Buffer.from(stableJsonStringifyV1({ ...publication, schemaVersion: 6 }));
      const compressed = gzipSync(payload);
      const legacyPublication = stableJsonStringifyV1({
        ...JSON.parse(row.value),
        payloadSha256: createHash("sha256").update(payload).digest("hex"),
        uncompressedBytes: payload.byteLength,
        compressedBytes: compressed.byteLength,
        payload: bytesToBase64(compressed),
      });
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?")
        .run(legacyPublication, SAFETY_SCORE_V9_CACHE_KEYS.publication);
      const legacyHealth = { ...currentInput(publication).publicationHealth, schemaVersion: 1 };
      sqlite.prepare("UPDATE cache SET value = ? WHERE key = ?")
        .run(stableJsonStringifyV1(legacyHealth), SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth);

      const health = {
        ...currentInput(publication).publicationHealth,
        status: "held" as const,
        attemptedAtSec: 120,
        heldSinceSec: 120,
        reasons: code === "coverage-floor-failed" ? [{ code, floorIds: ["active-assets"] }]
          : code === "assessment-failed" ? [{ code, detail: "Capture assessment failed." }]
            : [{ code }],
      };
      const heldInput = {
        publicationHealth: health,
        publicationAttempt: {
          schemaVersion: 1 as const, attemptedAtSec: 120, outcome: "held" as const,
          publicationGenerationId: null, quarantines: [], affectedAssetIds: [],
        },
        publicationClockSec: 120,
      };
      await expect(persistSafetyScoreV9Publication(db, {
        ...heldInput,
        publicationHealth: { ...health, attemptedAtSec: 100, heldSinceSec: 100 },
        publicationAttempt: { ...heldInput.publicationAttempt, attemptedAtSec: 100 },
        publicationClockSec: 100,
      })).rejects.toThrow(/health cutover/);
      await persistSafetyScoreV9Publication(db, heldInput);
      await expect(loadSafetyScoreV9PublicationHealth(db)).resolves.toEqual(health);
      await expect(loadSafetyScoreV9PublicationAttempt(db)).resolves.toMatchObject({
        attemptedAtSec: 120, outcome: "held",
      });
      expect(sqlite.prepare("SELECT value FROM cache WHERE key = ?")
        .get(SAFETY_SCORE_V9_CACHE_KEYS.publication)?.value).toBe(legacyPublication);
      const heldResponse = await handleReportCardsV9(db);
      expect(heldResponse.status).toBe(503);
      expect(await heldResponse.json()).toMatchObject({ reason: "publication-schema-cutover-pending" });

      const replacement = makeWorkerSafetyScoreV9Publication({
        publishedAtSec: 130, publicationGenerationId: "report-cards:v9:first-current",
      });
      await persistSafetyScoreV9Publication(db, currentInput(replacement));
      const currentResponse = await handleReportCardsV9(db);
      expect(currentResponse.status).toBe(200);
      expect(await currentResponse.json()).toMatchObject({
        safetyScoreIdentity: { publicationGenerationId: replacement.publicationGenerationId },
        publicationHealth: { schemaVersion: 2, status: "current" },
      });
    },
  );

  it("conflicts when a current publication commits between a held read and final batch", async () => {
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
    const installNewerRows = () => {
      raced = true;
      for (const row of newerRows) {
        sqlite
          .prepare("UPDATE cache SET value = ?, updated_at = ? WHERE key = ?")
          .run(row.value, row.updated_at, row.key);
      }
    };
    const racingDb = {
      ...db,
      batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
        if (!raced && statements.length === 1) {
          // Reproduce the regressed split-batch implementation: let its
          // retained-publication probe pass, then commit the current publication
          // before its separate health/attempt batch.
          const results = await db.batch<T>(statements);
          installNewerRows();
          return results;
        }
        if (!raced) installNewerRows();
        return db.batch<T>(statements);
      },
    } as D1Database;

    await expect(persistSafetyScoreV9Publication(racingDb, {
      publicationHealth: {
        schemaVersion: 2,
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
    expect(
      sqlite.prepare("SELECT key FROM cache ORDER BY key").all().map((row) => row.key),
    ).toEqual([
      SAFETY_SCORE_V9_CACHE_KEYS.publication,
      SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline,
      SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral,
      SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
      SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
      SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex,
    ].sort());
    const projectionRows = sqlite.prepare("SELECT key, value, updated_at FROM cache WHERE key IN (?, ?) ORDER BY key")
      .all(SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline, SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral);

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
    expect(sqlite.prepare("SELECT key, value, updated_at FROM cache WHERE key IN (?, ?) ORDER BY key")
      .all(SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline, SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral)).toEqual(projectionRows);

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
    const { sqlite, db } = database();
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
    const projectionRows = sqlite.prepare("SELECT key, value, updated_at FROM cache WHERE key IN (?, ?) ORDER BY key")
      .all(SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline, SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral);

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
    expect(sqlite.prepare("SELECT key, value, updated_at FROM cache WHERE key IN (?, ?) ORDER BY key")
      .all(SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline, SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral)).toEqual(projectionRows);

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

  it("loads attempt records persisted before quarantine causes were recorded", async () => {
    // Production regression: dispatch-telegram-alerts failed every run after
    // the schema gained a required quarantine message because the stored
    // last-attempt/last-failed-attempt rows predate it.
    const { sqlite, db } = database();
    const legacy = {
      schemaVersion: 1,
      attemptedAtSec: 100,
      outcome: "failed",
      publicationGenerationId: null,
      quarantines: [{ assetId: "usdt", code: "fact-build-failed" }],
      affectedAssetIds: ["usdt"],
      failure: { stage: "compile", code: "compile_failed", message: "compiler failed" },
    };
    sqlite
      .prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)")
      .run(
        SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt,
        stableJsonStringifyV1(legacy),
        100,
      );
    await expect(
      loadSafetyScoreV9FailedPublicationAttempt(db),
    ).resolves.toMatchObject({
      outcome: "failed",
      quarantines: [
        {
          assetId: "usdt",
          code: "fact-build-failed",
          message: "cause not recorded (legacy record)",
        },
      ],
    });
  });
});
