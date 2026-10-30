import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  V9PublicationHealthSchema,
  type V9PublicationHealth,
} from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentResponse } from "@shared/types/safety-score-v9-public";
import { throwIfAborted } from "../abort";
import { executeAtomicBatch } from "../db";
import { logWorkerEvent } from "../structured-log";
import {
  parseSafetyScoreV9Publication,
  type SafetyScoreV9AdmittedPublication,
  publicationIdentityFromStorageEnvelope,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
  SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
  admitAndSerializeSafetyScoreV9Publication,
  SafetyScoreV9SchemaCutoverPendingError,
} from "./publication-codec";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";
import { SafetyScoreIndexSchema } from "@shared/types/safety-score-index";
import { projectV9CompactPartialEvidence } from "@shared/types/safety-score-v9-causes";
import type { SafetyScoreCaptureArchiveCacheRows } from "@shared/types/safety-score-capture-archive";
import {
  stageV9PublicMaterialization,
  v9StagedPublicMaterializationStatements,
  type V9AcceptedPublicMaterializationSource,
  type V9StagedPublicMaterialization,
} from "../report-cards-v9-materialization";
import { SAFETY_SCORE_V9_CACHE_KEYS, loadSafetyScoreV9PublicationHealth } from "./publication-health";
import { V9PublicationAttemptSchema, loadSafetyScoreV9FailedPublicationAttempt, type V9PublicationAttempt } from "./publication-attempts";
import {
  loadSafetyScoreV9PublicationStoredRow,
  shardSafetyScoreV9PublicationStoredValue,
  shardedSafetyScoreV9PublicationChunkStatements,
  shardSafetyScoreV9CohortStoredValue,
  shardedSafetyScoreV9CohortChunkStatements,
} from "./publication-chunks";

class SafetyScoreV9PublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScoreV9PublicationConflictError";
  }
}

export async function loadSafetyScoreV9Publication(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9AdmittedPublication | null> {
  const row = await loadSafetyScoreV9PublicationStoredRow(db, signal);
  if (!row) return null;
  return parseSafetyScoreV9Publication(row.value, signal);
}

/**
 * Reads the active publication identity from the storage envelope via a
 * D1-side extraction, without transferring or inflating the compressed
 * publication body. Suitable for polled monitors such as `/api/health`.
 */
export async function loadSafetyScoreV9PublicationIdentityEnvelope(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9PublicationIdentity | null> {
  throwIfAborted(signal);
  const row = await db
    .prepare("SELECT json_extract(value, '$.identity') AS publication_identity FROM cache WHERE key = ?")
    .bind(SAFETY_SCORE_V9_CACHE_KEYS.publication)
    .first<{ publication_identity: string | null }>();
  throwIfAborted(signal);
  if (!row?.publication_identity) return null;
  try {
    return publicationIdentityFromStorageEnvelope(JSON.parse(row.publication_identity));
  } catch {
    return null;
  }
}

async function loadStoredSafetyScoreV9PublicationReference(
  db: D1Database,
): Promise<{
  publicationGenerationId: string | null;
  publishedAtSec: number;
} | null> {
  const row = await db
    .prepare(
      `SELECT
         updated_at AS published_at_sec,
         COALESCE(
           json_extract(value, '$.identity.publicationGenerationId'),
           json_extract(value, '$.publicationGenerationId')
         ) AS publication_generation_id
       FROM cache
       WHERE key = ?`,
    )
    .bind(SAFETY_SCORE_V9_CACHE_KEYS.publication)
    .first<{
      publication_generation_id: string | null;
      published_at_sec: number;
    }>();
  return row === null
    ? null
    : {
        publicationGenerationId: row.publication_generation_id,
        publishedAtSec: row.published_at_sec,
      };
}

export interface PersistSafetyScoreV9PublicationInput {
  publication?: SafetyScoreV9CurrentResponse;
  buildAcceptedProjections?: (publication: Readonly<SafetyScoreV9CurrentResponse>) => { baseline: string; lender: string; cohort: string };
  publicationReplayCaptureValue?: string;
  publicationReplayBaseValue?: string;
  publicationHealth: V9PublicationHealth;
  publicationAttempt: V9PublicationAttempt;
  publicationClockSec: number;
  signal?: AbortSignal;
  /** Filled with sub-phase wall time: pre-commit admission/reads versus the atomic write. */
  timing?: SafetyScoreV9PersistTiming;
  /**
   * Leave public representations to `materializeV9AcceptedPublication` after
   * acceptance. Otherwise they are staged first and selected in the acceptance
   * batch, which every reader version tolerates.
   */
  deferPublicMaterialization?: boolean;
}

export interface SafetyScoreV9PersistTiming {
  persistPrepare: number | null;
  persistCommit: number | null;
}

export interface PersistSafetyScoreV9PublicationResult {
  /** Exact committed transports for the capture archive, when replay retention was written. */
  captureArchiveCacheRows: SafetyScoreCaptureArchiveCacheRows | null;
  /** Source for the deferred public materialization; null when none is pending. */
  acceptedMaterialization: V9AcceptedPublicMaterializationSource | null;
}

export interface PersistSafetyScoreV9PublicationAttemptInput {
  publicationAttempt: V9PublicationAttempt;
  publicationClockSec: number;
  signal?: AbortSignal;
}

function validatePublicationAttemptInput(
  input: PersistSafetyScoreV9PublicationAttemptInput,
): V9PublicationAttempt {
  if (
    !Number.isInteger(input.publicationClockSec) ||
    input.publicationClockSec < 0
  ) {
    throw new Error(
      "Safety Score v9 publication clock must be non-negative epoch seconds",
    );
  }
  const attempt = V9PublicationAttemptSchema.parse(
    input.publicationAttempt,
  );
  if (attempt.attemptedAtSec !== input.publicationClockSec) {
    throw new Error(
      "Safety Score v9 publication attempt does not match its attempt clock",
    );
  }
  return attempt;
}

export async function persistSafetyScoreV9PublicationAttempt(
  db: D1Database,
  input: PersistSafetyScoreV9PublicationAttemptInput,
): Promise<void> {
  throwIfAborted(input.signal);
  const attempt = validatePublicationAttemptInput(input);
  const attemptValue = stableJsonStringifyV1(attempt);
  if (attempt.outcome !== "failed") {
    throw new Error(
      "Attempt-only Safety Score v9 persistence requires a failed attempt",
    );
  }
  const existingAttempt = await loadSafetyScoreV9FailedPublicationAttempt(
    db,
    input.signal,
  );
  if (
    existingAttempt !== null &&
    stableJsonStringifyV1(existingAttempt) !== attemptValue &&
    attempt.attemptedAtSec <= existingAttempt.attemptedAtSec
  ) {
    throw new SafetyScoreV9PublicationConflictError(
      "Stale or conflicting Safety Score v9 publication attempt update",
    );
  }
  await executeAtomicBatch(
    db,
    [
      db
        .prepare(
          `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = CASE
               WHEN cache.updated_at < excluded.updated_at
                 OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
               THEN excluded.value
               ELSE NULL
             END,
             updated_at = CASE
               WHEN cache.updated_at < excluded.updated_at
                 OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
               THEN excluded.updated_at
               ELSE -1
             END`,
        )
        .bind(
          SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt,
          attemptValue,
          input.publicationClockSec,
        ),
    ],
    { signal: input.signal },
  );
  throwIfAborted(input.signal);
}

export async function persistSafetyScoreV9Publication(
  db: D1Database,
  input: PersistSafetyScoreV9PublicationInput,
): Promise<PersistSafetyScoreV9PublicationResult> {
  const prepareStartedAtMs = Date.now();
  throwIfAborted(input.signal);
  if ((input.publicationReplayCaptureValue !== undefined) !== (input.publicationReplayBaseValue !== undefined)) {
    throw new Error("Accepted replay retention requires both base and delta or neither");
  }
  validatePublicationAttemptInput(input);
  const health = V9PublicationHealthSchema.parse(input.publicationHealth);
  const attempt = V9PublicationAttemptSchema.parse(
    input.publicationAttempt,
  );
  if (health.attemptedAtSec !== input.publicationClockSec) {
    throw new Error(
      "Safety Score v9 publication health does not match its attempt clock",
    );
  }
  if (attempt.attemptedAtSec !== input.publicationClockSec) {
    throw new Error(
      "Safety Score v9 publication attempt does not match its attempt clock",
    );
  }
  if (
    (health.status === "current") !==
    attempt.outcome.startsWith("published-")
  ) {
    throw new Error(
      "Safety Score v9 publication attempt does not match publication health",
    );
  }

  let publicationValue: string | null = null;
  let scoreIndexValue: string | null = null;
  let acceptedProjections: { baseline: string; lender: string; cohort: string } | null = null;
  let acceptedMaterialization: V9AcceptedPublicMaterializationSource | null = null;
  let stagedMaterialization: V9StagedPublicMaterialization | null = null;
  let publicationPayloadSha256: string | null = null;
  if (health.status === "current") {
    if (input.publication === undefined) {
      throw new Error(
        "Current Safety Score v9 health requires a publication",
      );
    }
    const { publication, stored } = await admitAndSerializeSafetyScoreV9Publication(
      input.publication, input.signal,
    );
    if (
      health.acceptedPublicationGenerationId !==
        publication.publicationGenerationId ||
      attempt.publicationGenerationId !==
        publication.publicationGenerationId ||
      health.acceptedAtSec !== publication.publishedAtSec ||
      publication.publishedAtSec !== input.publicationClockSec
    ) {
      throw new Error(
        "Safety Score v9 publication does not match current publication health",
      );
    }
    publicationValue = stored;
    const payloadSha256: string = (JSON.parse(stored) as { payloadSha256: string }).payloadSha256;
    publicationPayloadSha256 = payloadSha256;
    if (!input.buildAcceptedProjections) {
      throw new Error("Accepted Safety Score v9 publication requires projection builders");
    }
    acceptedProjections = input.buildAcceptedProjections(publication);
    if (input.deferPublicMaterialization) {
      acceptedMaterialization = { publication, health, payloadSha256 };
    } else {
      stagedMaterialization = await stageV9PublicMaterialization(db, publication, health, payloadSha256, input.signal);
    }
    scoreIndexValue = stableJsonStringifyV1(SafetyScoreIndexSchema.parse({
      schemaVersion: 2,
      safetyScoreIdentity: {
        model: "v9",
        schemaVersion: 1,
        methodologyVersion: publication.policyVersion,
        evaluationBuildDigest: publication.evaluationBuildDigest,
        baseInputGenerationId: publication.baseInputGenerationId,
        publicationGenerationId: publication.publicationGenerationId,
        policyId: publication.policy.id,
        policyDigest: publication.policy.semanticDigest,
      },
      publicationResultDigest: publication.resultDigest,
      asOfSec: publication.asOfSec,
      publishedAtSec: publication.publishedAtSec,
      expectedCount: publication.completeness.expectedCount,
      scores: Object.fromEntries(publication.cards.map(card => [
        card.id, {
          score: card.score, grade: card.grade, ratingStatus: card.ratingStatus,
          partialEvidence: projectV9CompactPartialEvidence(card.partialEvidence),
        },
      ])),
    }));
  } else if (input.publication !== undefined) {
    throw new Error(
      "Held Safety Score v9 health must retain the existing publication",
    );
  }

  const healthValue = stableJsonStringifyV1(health);
  const attemptValue = stableJsonStringifyV1(attempt);
  const existingHealth = await loadSafetyScoreV9PublicationHealth(
    db,
    input.signal,
  ).catch((error: unknown) => {
    if (!(error instanceof SafetyScoreV9SchemaCutoverPendingError) ||
        error.source !== "health") throw error;
    // Compare the old row clock without interpreting its retired health payload.
    if (error.storedUpdatedAt === null || health.attemptedAtSec <= error.storedUpdatedAt) {
      throw new SafetyScoreV9PublicationConflictError("Stale or conflicting Safety Score v9 publication health cutover");
    }
    return null;
  });
  if (
    existingHealth !== null &&
    stableJsonStringifyV1(existingHealth) !== healthValue &&
    health.attemptedAtSec <= existingHealth.attemptedAtSec
  ) {
    throw new SafetyScoreV9PublicationConflictError(
      "Stale or conflicting Safety Score v9 publication health update",
    );
  }
  let priorPublication: Awaited<ReturnType<typeof loadStoredSafetyScoreV9PublicationReference>> = null;
  if (health.status === "current") {
    // Compare the raw row clock so a newer valid publication can replace an
    // older retained payload that the current reader can no longer parse.
    const existingPublicationRow = priorPublication = await loadStoredSafetyScoreV9PublicationReference(
      db,
    );
    if (
      existingPublicationRow !== null &&
      existingPublicationRow.publishedAtSec > input.publicationClockSec
    ) {
      throw new SafetyScoreV9PublicationConflictError(
        "Stale or conflicting Safety Score v9 publication update",
      );
    }
  } else {
    const existingPublication = await loadStoredSafetyScoreV9PublicationReference(
      db,
    );
    const healthMatchesPublication = existingPublication === null
      ? health.acceptedPublicationGenerationId === null &&
        health.acceptedAtSec === null
      : health.acceptedPublicationGenerationId ===
          existingPublication.publicationGenerationId &&
        health.acceptedAtSec === existingPublication.publishedAtSec;
    if (!healthMatchesPublication) {
      throw new SafetyScoreV9PublicationConflictError(
        "Held Safety Score v9 health does not match the stored publication",
      );
    }
  }


  const cacheStatement = db.prepare(
    `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CASE
         WHEN cache.updated_at < excluded.updated_at
           OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
         THEN excluded.value
         ELSE NULL
       END,
       updated_at = CASE
         WHEN cache.updated_at < excluded.updated_at
           OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
         THEN excluded.updated_at
         ELSE -1
       END`,
  );
  const statements: D1PreparedStatement[] = [];
  if (publicationValue !== null) {
    // Always sharded: an admitted stored value can exceed D1's 2 MB row limit.
    const sharded = shardSafetyScoreV9PublicationStoredValue(publicationValue);
    const canonicalValue = sharded.envelope;
    statements.push(...shardedSafetyScoreV9PublicationChunkStatements(
      db, sharded, publicationPayloadSha256!, input.publicationClockSec,
    ));
    statements.push(
      db.prepare(`INSERT INTO cache (key, value, updated_at)
        VALUES (?, CASE WHEN
          (? IS NULL AND NOT EXISTS (SELECT 1 FROM cache WHERE key = ?))
          OR EXISTS (SELECT 1 FROM cache WHERE key = ? AND updated_at = ?
            AND COALESCE(json_extract(value, '$.identity.publicationGenerationId'),
              json_extract(value, '$.publicationGenerationId')) IS ?)
          THEN ? ELSE NULL END, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = CASE WHEN cache.updated_at < excluded.updated_at
            OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
            THEN excluded.value ELSE NULL END,
          updated_at = CASE WHEN cache.updated_at < excluded.updated_at
            OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
            THEN excluded.updated_at ELSE -1 END`).bind(
        SAFETY_SCORE_V9_CACHE_KEYS.publication,
        priorPublication?.publishedAtSec ?? null, SAFETY_SCORE_V9_CACHE_KEYS.publication,
        SAFETY_SCORE_V9_CACHE_KEYS.publication, priorPublication?.publishedAtSec ?? null,
        priorPublication?.publicationGenerationId ?? null, canonicalValue, input.publicationClockSec,
      ),
    );
    statements.push(cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.scoreIndex,
      scoreIndexValue,
      input.publicationClockSec,
    ));
    const cohort = shardSafetyScoreV9CohortStoredValue(acceptedProjections!.cohort);
    statements.push(...shardedSafetyScoreV9CohortChunkStatements(db, cohort, input.publicationClockSec));
    statements.push(cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.cohort,
      cohort.envelope,
      input.publicationClockSec,
    ));
    statements.push(cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.acceptedBaseline,
      acceptedProjections!.baseline,
      input.publicationClockSec,
    ));
    statements.push(cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.lenderCollateral,
      acceptedProjections!.lender,
      input.publicationClockSec,
    ));
    if (stagedMaterialization !== null) {
      statements.push(...v9StagedPublicMaterializationStatements(db, stagedMaterialization));
    }
    if (input.publicationReplayCaptureValue !== undefined) {
      statements.push(cacheStatement.bind(
        SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
        input.publicationReplayCaptureValue,
        input.publicationClockSec,
      ));
    }
    if (input.publicationReplayBaseValue !== undefined) {
      statements.push(cacheStatement.bind(
        SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
        input.publicationReplayBaseValue,
        input.publicationClockSec,
      ));
    }
  }
  if (health.status === "held" && health.acceptedAtSec !== null) {
    // Keep the retained-publication CAS in the same transaction as the sidecar
    // writes. The guarded health value turns a failed predicate into a NOT NULL
    // violation so D1 rolls the whole batch back.
    statements.push(
      db
        .prepare(
          `UPDATE cache
           SET value = value
           WHERE key = ? AND updated_at = ?`,
        )
        .bind(
          SAFETY_SCORE_V9_CACHE_KEYS.publication,
          health.acceptedAtSec,
        ),
    );
    statements.push(
      db
        .prepare(
          `INSERT INTO cache (key, value, updated_at)
           VALUES (
             ?,
             CASE
               WHEN EXISTS (
                 SELECT 1 FROM cache
                 WHERE key = ? AND updated_at = ?
               )
               THEN ?
               ELSE NULL
             END,
             ?
           )
           ON CONFLICT(key) DO UPDATE SET
             value = CASE
               WHEN cache.updated_at < excluded.updated_at
                 OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
               THEN excluded.value
               ELSE NULL
             END,
             updated_at = CASE
               WHEN cache.updated_at < excluded.updated_at
                 OR (cache.updated_at = excluded.updated_at AND cache.value = excluded.value)
               THEN excluded.updated_at
               ELSE -1
             END`,
        )
        .bind(
          SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
          SAFETY_SCORE_V9_CACHE_KEYS.publication,
          health.acceptedAtSec,
          healthValue,
          input.publicationClockSec,
        ),
    );
  } else {
    statements.push(
      cacheStatement.bind(
        SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
        healthValue,
        input.publicationClockSec,
      ),
    );
  }
  statements.push(
    cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
      attemptValue,
      input.publicationClockSec,
    ),
  );
  if (input.timing) input.timing.persistPrepare = Date.now() - prepareStartedAtMs;
  const commitStartedAtMs = Date.now();
  try {
    await executeAtomicBatch(db, statements, { signal: input.signal });
  } finally {
    if (input.timing) input.timing.persistCommit = Date.now() - commitStartedAtMs;
  }
  throwIfAborted(input.signal);
  if (acceptedProjections !== null) {
    logWorkerEvent({
      scope: "lib", level: "info", event: "safety_score_v9_accepted_projections_written",
      message: "Accepted Safety Score v9 projections committed",
      metadata: {
        publicationClockSec: input.publicationClockSec,
        cohortBytes: new TextEncoder().encode(acceptedProjections.cohort).byteLength,
        baselineBytes: new TextEncoder().encode(acceptedProjections.baseline).byteLength,
        lenderBytes: new TextEncoder().encode(acceptedProjections.lender).byteLength,
      },
    });
  }
  // Return references to the exact committed transports, never re-encode or
  // re-read live cache rows which a later accepted generation could overwrite.
  // A sharded publication is archived as its single-row-equivalent value.
  if (publicationValue === null || input.publicationReplayBaseValue === undefined ||
      input.publicationReplayCaptureValue === undefined) return { captureArchiveCacheRows: null, acceptedMaterialization };
  return {
    captureArchiveCacheRows: {
      base: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY,
        value: input.publicationReplayBaseValue, updatedAt: input.publicationClockSec },
      delta: { key: SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY,
        value: input.publicationReplayCaptureValue, updatedAt: input.publicationClockSec },
      cards: { key: SAFETY_SCORE_V9_CACHE_KEYS.publication,
        value: publicationValue, updatedAt: input.publicationClockSec },
    },
    acceptedMaterialization,
  };
}
