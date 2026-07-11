import { getCache, type CacheWriteResult } from "./db-cache";
import { sha256Hex } from "@shared/lib/sha256";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";

const DEWS_PUBLICATION_POINTER_CACHE_KEY = "dews:published-generation";
const DEWS_PUBLICATION_POINTER_SOURCE = "compute-dews";
const DEWS_PUBLICATION_POINTER_STATUS = "published";
const DEWS_PUBLICATION_POINTER_COVERAGE_VERSION = 2;
const DEWS_PUBLICATION_SURFACE = "dews";

const UPSERT_DEWS_PUBLICATION_LEDGER_SQL = `
  ON CONFLICT(surface, generation_id) DO UPDATE SET
    validated_at = excluded.validated_at,
    published_at = excluded.published_at,
    state = 'published',
    candidate_rows = COALESCE(excluded.candidate_rows, surface_publication_generations.candidate_rows),
    published_rows = COALESCE(excluded.published_rows, surface_publication_generations.published_rows),
    expected_rows = COALESCE(excluded.expected_rows, surface_publication_generations.expected_rows),
    validation_summary_json = COALESCE(
      excluded.validation_summary_json,
      surface_publication_generations.validation_summary_json
    ),
    artifact_checksum = COALESCE(excluded.artifact_checksum, surface_publication_generations.artifact_checksum),
    artifact_cache_key = COALESCE(excluded.artifact_cache_key, surface_publication_generations.artifact_cache_key)`;

interface DewsPublicationPointerPayload {
  updatedAt: number;
  source: typeof DEWS_PUBLICATION_POINTER_SOURCE;
  publishStatus: typeof DEWS_PUBLICATION_POINTER_STATUS;
  coverageVersion: typeof DEWS_PUBLICATION_POINTER_COVERAGE_VERSION;
  expectedRowCount: number;
  stablecoinIdsDigest: string;
}

export type DewsPublishedGenerationResult =
  | {
      status: "ok";
      computedAt: number;
      expectedRowCount: number | null;
      stablecoinIdsDigest: string | null;
    }
  | { status: "no-pointer" }
  | { status: "invalid-pointer"; reason: string }
  | { status: "read-failed"; error: string };

export function buildDewsStablecoinIdsDigest(stablecoinIds: Iterable<string>): string {
  return sha256Hex([...new Set(stablecoinIds)].sort().join("\n"));
}

function buildDewsPublicationPointerPayload(
  updatedAt: number,
  stablecoinIds: readonly string[],
): DewsPublicationPointerPayload {
  return {
    updatedAt,
    source: DEWS_PUBLICATION_POINTER_SOURCE,
    publishStatus: DEWS_PUBLICATION_POINTER_STATUS,
    coverageVersion: DEWS_PUBLICATION_POINTER_COVERAGE_VERSION,
    expectedRowCount: stablecoinIds.length,
    stablecoinIdsDigest: buildDewsStablecoinIdsDigest(stablecoinIds),
  };
}

function dewsGenerationId(computedAt: number): string {
  return `dews:${computedAt}`;
}

function buildDewsPublicationValidationSummary(
  expectedRowCount: number | null,
  stablecoinIdsDigest: string | null,
): string | null {
  return expectedRowCount == null || stablecoinIdsDigest == null
    ? null
    : JSON.stringify({
        coverageVersion: DEWS_PUBLICATION_POINTER_COVERAGE_VERSION,
        expectedRowCount,
        stablecoinIdsDigest,
      });
}

function prepareDewsPublicationLedgerUpsert(
  db: D1Database,
  publication: {
    computedAt: number;
    expectedRowCount: number | null;
    stablecoinIdsDigest: string | null;
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO surface_publication_generations (
       surface, generation_id, started_at, validated_at, published_at, state,
       candidate_rows, published_rows, expected_rows, validation_summary_json,
       artifact_checksum, artifact_cache_key
     ) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?)
     ${UPSERT_DEWS_PUBLICATION_LEDGER_SQL}`,
  ).bind(
    DEWS_PUBLICATION_SURFACE,
    dewsGenerationId(publication.computedAt),
    publication.computedAt,
    publication.computedAt,
    publication.computedAt,
    publication.expectedRowCount,
    publication.expectedRowCount,
    publication.expectedRowCount,
    buildDewsPublicationValidationSummary(
      publication.expectedRowCount,
      publication.stablecoinIdsDigest,
    ),
    publication.stablecoinIdsDigest,
    DEWS_PUBLICATION_POINTER_CACHE_KEY,
  );
}

function prepareGatedDewsPublicationLedgerUpsert(
  db: D1Database,
  publication: {
    computedAt: number;
    expectedRowCount: number;
    stablecoinIdsDigest: string;
    pointerValue: string;
  },
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO surface_publication_generations (
       surface, generation_id, started_at, validated_at, published_at, state,
       candidate_rows, published_rows, expected_rows, validation_summary_json,
       artifact_checksum, artifact_cache_key
     )
     SELECT ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM cache
         WHERE key = ? AND updated_at = ? AND value = ?
      )
     ${UPSERT_DEWS_PUBLICATION_LEDGER_SQL}`,
  ).bind(
    DEWS_PUBLICATION_SURFACE,
    dewsGenerationId(publication.computedAt),
    publication.computedAt,
    publication.computedAt,
    publication.computedAt,
    publication.expectedRowCount,
    publication.expectedRowCount,
    publication.expectedRowCount,
    buildDewsPublicationValidationSummary(
      publication.expectedRowCount,
      publication.stablecoinIdsDigest,
    ),
    publication.stablecoinIdsDigest,
    DEWS_PUBLICATION_POINTER_CACHE_KEY,
    DEWS_PUBLICATION_POINTER_CACHE_KEY,
    publication.computedAt,
    publication.pointerValue,
  );
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseDewsPublishedGeneration(
  cached: { value: string; updatedAt: number } | null,
  nowSec: number,
): DewsPublishedGenerationResult {
  if (!cached) return { status: "no-pointer" };
  try {
    const parsed = JSON.parse(cached.value) as Partial<DewsPublicationPointerPayload> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "invalid-pointer", reason: "payload is not an object" };
    }
    if (parsed.source !== DEWS_PUBLICATION_POINTER_SOURCE) {
      return { status: "invalid-pointer", reason: "payload source is not compute-dews" };
    }
    if (parsed.publishStatus !== DEWS_PUBLICATION_POINTER_STATUS) {
      return { status: "invalid-pointer", reason: "payload publishStatus is not published" };
    }
    if (typeof parsed.updatedAt !== "number" || !Number.isInteger(parsed.updatedAt)) {
      return { status: "invalid-pointer", reason: "payload updatedAt is not an integer" };
    }
    if (parsed.updatedAt < 0) {
      return { status: "invalid-pointer", reason: "payload updatedAt is negative" };
    }
    if (parsed.updatedAt > nowSec) {
      return { status: "invalid-pointer", reason: "payload updatedAt is in the future" };
    }
    if (parsed.updatedAt !== cached.updatedAt) {
      return { status: "invalid-pointer", reason: "payload updatedAt does not match cache updated_at" };
    }
    if (parsed.coverageVersion == null) {
      return {
        status: "ok",
        computedAt: parsed.updatedAt,
        expectedRowCount: null,
        stablecoinIdsDigest: null,
      };
    }
    if (parsed.coverageVersion !== DEWS_PUBLICATION_POINTER_COVERAGE_VERSION) {
      return { status: "invalid-pointer", reason: "payload coverageVersion is unsupported" };
    }
    if (
      typeof parsed.expectedRowCount !== "number"
      || !Number.isInteger(parsed.expectedRowCount)
      || parsed.expectedRowCount <= 0
    ) {
      return { status: "invalid-pointer", reason: "payload expectedRowCount is not a positive integer" };
    }
    if (
      typeof parsed.stablecoinIdsDigest !== "string"
      || !/^[a-f0-9]{64}$/.test(parsed.stablecoinIdsDigest)
    ) {
      return { status: "invalid-pointer", reason: "payload stablecoinIdsDigest is not SHA-256" };
    }
    return {
      status: "ok",
      computedAt: parsed.updatedAt,
      expectedRowCount: parsed.expectedRowCount,
      stablecoinIdsDigest: parsed.stablecoinIdsDigest,
    };
  } catch (error) {
    return { status: "invalid-pointer", reason: `payload is not valid JSON: ${errorToMessage(error)}` };
  }
}

export async function readDewsPublishedGenerationResult(
  db: D1Database,
  nowSec: number,
): Promise<DewsPublishedGenerationResult> {
  try {
    const cached = await getCache(db, DEWS_PUBLICATION_POINTER_CACHE_KEY);
    return parseDewsPublishedGeneration(cached, nowSec);
  } catch (error) {
    return { status: "read-failed", error: errorToMessage(error) };
  }
}

/**
 * Backfill/reconcile the current validated cache pointer into the durable
 * generation ledger. This closes the migration-to-deploy window where the old
 * Worker may advance the pointer after migration 0182 has run.
 */
export async function reconcileDewsPublishedGenerationLedger(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DewsPublishedGenerationResult> {
  const published = await readDewsPublishedGenerationResult(db, nowSec);
  if (published.status !== "ok") return published;
  throwIfAborted(signal);
  await runWithOverloadRetry(
    () => prepareDewsPublicationLedgerUpsert(db, {
      computedAt: published.computedAt,
      expectedRowCount: published.expectedRowCount,
      stablecoinIdsDigest: published.stablecoinIdsDigest,
    }).run(),
    3,
    signal,
  );
  throwIfAborted(signal);
  return published;
}

export async function writeDewsPublishedGeneration(
  db: D1Database,
  updatedAt: number,
  stablecoinIds: readonly string[],
  signal?: AbortSignal,
): Promise<CacheWriteResult> {
  const payload = buildDewsPublicationPointerPayload(updatedAt, stablecoinIds);
  const pointerValue = JSON.stringify(payload);
  throwIfAborted(signal);
  const [pointerResult] = await runWithOverloadRetry(
    () => db.batch([
      db.prepare(
        `INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
         WHERE cache.updated_at <= excluded.updated_at`,
      ).bind(DEWS_PUBLICATION_POINTER_CACHE_KEY, pointerValue, updatedAt),
      prepareGatedDewsPublicationLedgerUpsert(db, {
        computedAt: updatedAt,
        expectedRowCount: payload.expectedRowCount,
        stablecoinIdsDigest: payload.stablecoinIdsDigest,
        pointerValue,
      }),
    ]),
    3,
    signal,
  );
  throwIfAborted(signal);
  const written = Number(pointerResult?.meta?.changes ?? 0) > 0;
  if (!written) {
    console.log(`[cache] Skipped write for "${DEWS_PUBLICATION_POINTER_CACHE_KEY}" — existing data is newer (started_at > ${updatedAt})`);
  }
  return { written, skippedBecauseNewer: !written };
}
