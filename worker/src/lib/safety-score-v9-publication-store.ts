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
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./cron-lease";
import { executeAtomicBatch } from "./db";
import { parseJson } from "./json-parse";
import {
  parseSafetyScoreV9Publication,
  serializeSafetyScoreV9Publication,
} from "./safety-score-v9-publication-codec";

export const SAFETY_SCORE_V9_CACHE_KEYS = {
  publication: "report-cards:v9",
  publicationHealth: "report-cards:v9:publication-health",
} as const;

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
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare("SELECT value, updated_at FROM cache WHERE key = ?")
        .bind(SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth)
        .first<{ value: string; updated_at: number }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (!row) return null;
  const health = parseCanonicalJson(
    row.value,
    V9PublicationHealthSchema,
    "Safety Score v9 publication health",
  );
  if (row.updated_at !== health.attemptedAtSec) {
    throw new Error(
      "Safety Score v9 publication health cache timestamp mismatch",
    );
  }
  return health;
}

export async function loadSafetyScoreV9Publication(
  db: D1Database,
  signal?: AbortSignal,
): Promise<SafetyScoreV9CurrentResponse | null> {
  throwIfAborted(signal);
  const row = await runWithOverloadRetry(
    () =>
      db
        .prepare("SELECT value FROM cache WHERE key = ?")
        .bind(SAFETY_SCORE_V9_CACHE_KEYS.publication)
        .first<{ value: string }>(),
    3,
    signal,
  );
  throwIfAborted(signal);
  if (!row) return null;
  return parseSafetyScoreV9Publication(row.value, signal);
}

export interface PersistSafetyScoreV9PublicationInput {
  publication?: SafetyScoreV9CurrentResponse;
  publicationHealth: V9PublicationHealth;
  publicationClockSec: number;
  signal?: AbortSignal;
}

export async function persistSafetyScoreV9Publication(
  db: D1Database,
  input: PersistSafetyScoreV9PublicationInput,
): Promise<void> {
  throwIfAborted(input.signal);
  if (
    !Number.isInteger(input.publicationClockSec) ||
    input.publicationClockSec < 0
  ) {
    throw new Error(
      "Safety Score v9 publication clock must be non-negative epoch seconds",
    );
  }
  const health = V9PublicationHealthSchema.parse(input.publicationHealth);
  if (health.attemptedAtSec !== input.publicationClockSec) {
    throw new Error(
      "Safety Score v9 publication health does not match its attempt clock",
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
  statements.push(
    cacheStatement.bind(
      SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth,
      healthValue,
      input.publicationClockSec,
    ),
  );
  await executeAtomicBatch(db, statements, { signal: input.signal });
  throwIfAborted(input.signal);
}
