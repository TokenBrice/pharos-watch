import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import {
  V9PublicationHealthSchema,
  type V9PublicationHealth,
} from "@shared/types/report-cards-v9";
import {
  SafetyScoreV9CurrentResponseSchema,
  type SafetyScoreV9CurrentResponse,
} from "@shared/types/safety-score-v9-public";
import { z } from "zod";
import { throwIfAborted } from "../abort";
import { getCache } from "../db-cache";
import { executeAtomicBatch } from "../db";
import { parseJson } from "../json-parse";
import {
  parseSafetyScoreV9Publication,
  publicationIdentityFromStorageEnvelope,
  serializeSafetyScoreV9Publication,
} from "./publication-codec";
import type { SafetyScoreV9PublicationIdentity } from "@shared/types/safety-score-publication";

export const SAFETY_SCORE_V9_CACHE_KEYS = {
  publication: "report-cards:v9",
  publicationHealth: "report-cards:v9:publication-health",
  publicationAttempt: "report-cards:v9:last-attempt",
  failedPublicationAttempt: "report-cards:v9:last-failed-attempt",
} as const;

const V9AssetQuarantineSchema = z
  .object({
    assetId: z.string().min(1),
    code: z.enum([
      "fact-build-failed",
      "fact-validation-failed",
    ]),
  })
  .strict();

const V9PublicationAttemptFailureSchema = z
  .object({
    stage: z.enum([
      "base-input",
      "v9-enrichment",
      "compile",
      "publication-gate",
      "publication-write",
      "aborted",
    ]),
    code: z.string().min(1).max(160),
    message: z.string().min(1).max(500),
  })
  .strict();

const V9PublicationAttemptSchema = z
  .object({
    schemaVersion: z.literal(1),
    attemptedAtSec: z.number().int().nonnegative(),
    outcome: z.enum([
      "published-clean",
      "published-partial",
      "held",
      "failed",
    ]),
    publicationGenerationId: z.string().min(1).nullable(),
    quarantines: z.array(V9AssetQuarantineSchema),
    affectedAssetIds: z.array(z.string().min(1)),
    failure: V9PublicationAttemptFailureSchema.optional(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    for (const [path, ids] of [
      [
        "quarantines",
        attempt.quarantines.map((quarantine) => quarantine.assetId),
      ],
      ["affectedAssetIds", attempt.affectedAssetIds],
    ] as const) {
      if (
        new Set(ids).size !== ids.length ||
        ids.some(
          (assetId, index) =>
            index > 0 && ids[index - 1]! >= assetId,
        )
      ) {
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: `${path} must be unique and sorted`,
        });
      }
    }
    const affected = new Set(attempt.affectedAssetIds);
    if (
      attempt.quarantines.some(
        (quarantine) => !affected.has(quarantine.assetId),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["affectedAssetIds"],
        message: "Affected assets must include every quarantine",
      });
    }
    const published = attempt.outcome.startsWith("published-");
    if (published !== (attempt.publicationGenerationId !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["publicationGenerationId"],
        message:
          "Only published attempts carry a publication generation",
      });
    }
    if (
      attempt.outcome === "published-clean" &&
      (attempt.quarantines.length > 0 ||
        attempt.affectedAssetIds.length > 0)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["outcome"],
        message: "A clean publication cannot carry affected assets",
      });
    }
    if (
      attempt.outcome === "published-partial" &&
      attempt.affectedAssetIds.length === 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["affectedAssetIds"],
        message: "A partial publication requires affected assets",
      });
    }
    if ((attempt.outcome === "failed") !== (attempt.failure !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["failure"],
        message: "Only failed attempts must carry failure metadata",
      });
    }
  });
export type V9PublicationAttempt = z.infer<
  typeof V9PublicationAttemptSchema
>;

class SafetyScoreV9PublicationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafetyScoreV9PublicationConflictError";
  }
}

function parseCanonicalJson<T>(
  raw: string,
  schema: z.ZodType<T>,
  label: string,
): T {
  const parsed = parseJson(raw);
  if (!parsed.ok) throw new Error(`Malformed ${label} JSON: ${parsed.message}`);
  const value = schema.parse(parsed.value);
  if (stableJsonStringifyV1(value) !== raw) {
    throw new Error(`${label} JSON is not canonical`);
  }
  return value;
}

export async function loadSafetyScoreV9PublicationHealth(
  db: D1Database,
  signal?: AbortSignal,
): Promise<V9PublicationHealth | null> {
  const row = await getCache(db, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth, signal);
  if (!row) return null;
  const health = parseCanonicalJson(
    row.value,
    V9PublicationHealthSchema,
    "Safety Score v9 publication health",
  );
  if (row.updatedAt !== health.attemptedAtSec) {
    throw new Error(
      "Safety Score v9 publication health cache timestamp mismatch",
    );
  }
  return health;
}

async function loadSafetyScoreV9PublicationAttemptAtKey(
  db: D1Database,
  key: string,
  signal?: AbortSignal,
): Promise<V9PublicationAttempt | null> {
  const row = await getCache(db, key, signal);
  if (!row) return null;
  const attempt = parseCanonicalJson(
    row.value,
    V9PublicationAttemptSchema,
    "Safety Score v9 publication attempt",
  );
  if (row.updatedAt !== attempt.attemptedAtSec) {
    throw new Error(
      "Safety Score v9 publication attempt cache timestamp mismatch",
    );
  }
  return attempt;
}

export async function loadSafetyScoreV9PublicationAttempt(
  db: D1Database,
  signal?: AbortSignal,
): Promise<V9PublicationAttempt | null> {
  return loadSafetyScoreV9PublicationAttemptAtKey(
    db,
    SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
    signal,
  );
}

export async function loadSafetyScoreV9FailedPublicationAttempt(
  db: D1Database,
  signal?: AbortSignal,
): Promise<V9PublicationAttempt | null> {
  return loadSafetyScoreV9PublicationAttemptAtKey(
    db,
    SAFETY_SCORE_V9_CACHE_KEYS.failedPublicationAttempt,
    signal,
  );
}

export async function loadSafetyScoreV9Publication(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9CurrentResponse | null> {
  const row = await getCache(db, SAFETY_SCORE_V9_CACHE_KEYS.publication, signal);
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
): Promise<SafetyScoreV9PublicationIdentity | null> {
  const row = await db
    .prepare("SELECT json_extract(value, '$.identity') AS publication_identity FROM cache WHERE key = ?")
    .bind(SAFETY_SCORE_V9_CACHE_KEYS.publication)
    .first<{ publication_identity: string | null }>();
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
  publicationHealth: V9PublicationHealth;
  publicationAttempt: V9PublicationAttempt;
  publicationClockSec: number;
  signal?: AbortSignal;
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
): Promise<void> {
  throwIfAborted(input.signal);
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
  if (health.status === "current") {
    if (input.publication === undefined) {
      throw new Error(
        "Current Safety Score v9 health requires a publication",
      );
    }
    const publication = SafetyScoreV9CurrentResponseSchema.parse(
      input.publication,
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
    publicationValue = await serializeSafetyScoreV9Publication(
      publication,
      input.signal,
    );
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
  );
  if (
    existingHealth !== null &&
    stableJsonStringifyV1(existingHealth) !== healthValue &&
    health.attemptedAtSec <= existingHealth.attemptedAtSec
  ) {
    throw new SafetyScoreV9PublicationConflictError(
      "Stale or conflicting Safety Score v9 publication health update",
    );
  }
  if (health.status === "current") {
    // Compare the raw row clock so a newer valid publication can replace an
    // older retained payload that the current reader can no longer parse.
    const existingPublicationRow = await loadStoredSafetyScoreV9PublicationReference(
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
    statements.push(
      cacheStatement.bind(
        SAFETY_SCORE_V9_CACHE_KEYS.publication,
        publicationValue,
        input.publicationClockSec,
      ),
    );
  }
  if (health.status === "held" && health.acceptedAtSec !== null) {
    // Recheck the retained publication inside the atomic batch. A concurrent
    // current publication must roll this held attempt back instead of letting
    // health advance with the identity loaded before the race.
    statements.push(
      db
        .prepare(
          `UPDATE cache
           SET value = CASE WHEN updated_at = ? THEN value ELSE NULL END
           WHERE key = ?`,
        )
        .bind(
          health.acceptedAtSec,
          SAFETY_SCORE_V9_CACHE_KEYS.publication,
        ),
    );
  }
  statements.push(
    cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
      healthValue,
      input.publicationClockSec,
    ),
  );
  statements.push(
    cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.publicationAttempt,
      attemptValue,
      input.publicationClockSec,
    ),
  );
  await executeAtomicBatch(db, statements, { signal: input.signal });
  throwIfAborted(input.signal);
}
