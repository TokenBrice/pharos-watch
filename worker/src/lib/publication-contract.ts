import type {
  PublicationSurfaceFailure,
  PublicationGenerationHealth,
  PublicationGenerationState,
  PublicationHealth,
  PublicationSurfaceHealth,
  PublicationSurfaceId,
} from "@shared/types/status";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { getResponseReadyCacheKey } from "./api-cache-read";
import { getCacheUpdatedAt } from "./db-cache";
import { isMissingTableError } from "./db";
import { parseObjectMetadata } from "./json-metadata";
import { loadStablecoinsCache } from "./stablecoins-cache";
import { loadPublishedStressSignalGeneration } from "./stress-signals-current-rows";
import { loadActiveSafetyScoreSource } from "./safety-score-active-source";

interface PublicationGenerationRow {
  generation_id: string;
  source_state: string;
  started_at: number;
  validated_at: number | null;
  published_at: number | null;
  failed_at: number | null;
  candidate_rows: number | null;
  published_rows: number | null;
  expected_rows: number | null;
  failure_reason: string | null;
  metadata_json: string | null;
}

interface PublicationSurfaceDefinition {
  surface: PublicationSurfaceId;
  label: string;
  sourceOfTruth: string;
}

interface PublicationSurfaceLoader {
  definition: PublicationSurfaceDefinition;
  load: (db: D1Database, now: number) => Promise<PublicationSurfaceHealth | null>;
}

const DEX_LIQUIDITY_SURFACE: PublicationSurfaceDefinition = {
  surface: "dex-liquidity",
  label: "DEX liquidity",
  sourceOfTruth: "dex_liquidity_publication_generations",
};

const YIELD_RANKINGS_SURFACE: PublicationSurfaceDefinition = {
  surface: "yield-rankings",
  label: "Yield rankings",
  sourceOfTruth: "yield_publication_generations",
};

const STABLECOINS_SURFACE: PublicationSurfaceDefinition = {
  surface: "stablecoins",
  label: "Stablecoins cache",
  sourceOfTruth: "surface_publication_generations",
};

const STABLECOINS_CACHE_SURFACE: PublicationSurfaceDefinition = {
  ...STABLECOINS_SURFACE,
  sourceOfTruth: "cache[stablecoins]",
};

const DEWS_SURFACE: PublicationSurfaceDefinition = {
  surface: "dews",
  label: "DEWS risk signals",
  sourceOfTruth: "surface_publication_generations",
};

const DEWS_POINTER_SURFACE: PublicationSurfaceDefinition = {
  ...DEWS_SURFACE,
  sourceOfTruth: "cache[dews:published-generation]+stress_signal_publication_rows",
};

const PSI_SURFACE: PublicationSurfaceDefinition = {
  surface: "psi",
  label: "PSI samples",
  sourceOfTruth: "surface_publication_generations",
};

const PSI_SAMPLE_SURFACE: PublicationSurfaceDefinition = {
  ...PSI_SURFACE,
  sourceOfTruth: "stability_index_samples",
};

const SAFETY_SCORE_V9_SURFACE: PublicationSurfaceDefinition = {
  surface: "safety-score-v9",
  label: "Safety Score V9",
  sourceOfTruth: "cache[report-cards:v9]+cache[report-cards:v9:publication-health]",
};

function mapSourceState(state: string): PublicationGenerationState {
  if (state === "staged") return "candidate";
  if (
    state === "candidate" ||
    state === "validated" ||
    state === "published" ||
    state === "rejected" ||
    state === "superseded" ||
    state === "failed"
  ) {
    return state;
  }
  return "failed";
}

function mapGenerationRow(
  row: PublicationGenerationRow | null,
  latestPublished: PublicationGenerationRow | null,
): PublicationGenerationHealth | null {
  if (!row) return null;
  const canonicalState =
    row.source_state === "published" &&
    latestPublished != null &&
    latestPublished.generation_id !== row.generation_id
      ? "superseded"
      : mapSourceState(row.source_state);
  const metadata = parseObjectMetadata(row.metadata_json);
  return {
    generationId: row.generation_id,
    sourceState: row.source_state,
    state: canonicalState,
    startedAt: row.started_at,
    validatedAt: row.validated_at,
    publishedAt: row.published_at,
    failedAt: row.failed_at,
    candidateRows: row.candidate_rows,
    publishedRows: row.published_rows,
    expectedRows: row.expected_rows,
    failureReason: row.failure_reason,
    ...(metadata ? { metadata } : {}),
  };
}

function extractWatermarks(generation: PublicationGenerationHealth | null): Record<string, unknown> | null {
  const metadata = generation?.metadata;
  if (!metadata) return null;
  const inputWatermarks = metadata.inputWatermarks;
  if (inputWatermarks && typeof inputWatermarks === "object" && !Array.isArray(inputWatermarks)) {
    return inputWatermarks as Record<string, unknown>;
  }
  const dependencyWatermarks = metadata.dependencyWatermarks;
  if (dependencyWatermarks && typeof dependencyWatermarks === "object" && !Array.isArray(dependencyWatermarks)) {
    return dependencyWatermarks as Record<string, unknown>;
  }
  return null;
}

function buildSurfaceHealth(
  definition: PublicationSurfaceDefinition,
  now: number,
  latestAttemptedRow: PublicationGenerationRow | null,
  latestPublishedRow: PublicationGenerationRow | null,
  latestFailedRow: PublicationGenerationRow | null,
): PublicationSurfaceHealth {
  const lastPublishedGeneration = mapGenerationRow(latestPublishedRow, latestPublishedRow);
  const lastAttemptedGeneration = mapGenerationRow(latestAttemptedRow, latestPublishedRow);
  const latestFailedGeneration = mapGenerationRow(latestFailedRow, latestPublishedRow);
  return {
    surface: definition.surface,
    label: definition.label,
    sourceOfTruth: definition.sourceOfTruth,
    lastPublishedGeneration,
    lastAttemptedGeneration,
    lastFailureReason: latestFailedGeneration?.failureReason ?? null,
    candidateAgeSec: lastAttemptedGeneration?.state === "candidate"
      ? Math.max(0, now - lastAttemptedGeneration.startedAt)
      : null,
    dependencyWatermarks: extractWatermarks(lastAttemptedGeneration) ?? extractWatermarks(lastPublishedGeneration),
  };
}

async function firstRow(db: D1Database, sql: string): Promise<PublicationGenerationRow | null> {
  return runWithOverloadRetry(() => db.prepare(sql).first<PublicationGenerationRow>(), 2);
}

async function firstBoundRow(
  db: D1Database,
  sql: string,
  ...binds: unknown[]
): Promise<PublicationGenerationRow | null> {
  return runWithOverloadRetry(() => db.prepare(sql).bind(...binds).first<PublicationGenerationRow>(), 2);
}

async function loadDexLiquidityPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const selectColumns = `
    generation_id,
    state AS source_state,
    started_at,
    NULL AS validated_at,
    published_at,
    failed_at,
    written_row_count AS candidate_rows,
    current_row_count AS published_rows,
    expected_row_count AS expected_rows,
    failure_reason,
    metadata_json`;
  const [latestAttempted, latestPublished, latestFailed] = await Promise.all([
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM dex_liquidity_publication_generations
        ORDER BY started_at DESC
        LIMIT 1`,
    ),
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM dex_liquidity_publication_generations
        WHERE state = 'published'
        ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC
        LIMIT 1`,
    ),
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM dex_liquidity_publication_generations
        WHERE state = 'failed'
        ORDER BY COALESCE(failed_at, started_at) DESC, started_at DESC
        LIMIT 1`,
    ),
  ]);
  return buildSurfaceHealth(DEX_LIQUIDITY_SURFACE, now, latestAttempted, latestPublished, latestFailed);
}

async function loadYieldRankingsPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const selectColumns = `
    generation_id,
    state AS source_state,
    started_at,
    NULL AS validated_at,
    published_at,
    failed_at,
    source_row_count AS candidate_rows,
    ranking_count AS published_rows,
    best_row_count AS expected_rows,
    failure_reason,
    metadata_json`;
  const [latestAttempted, latestPublished, latestFailed] = await Promise.all([
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM yield_publication_generations
        ORDER BY started_at DESC
        LIMIT 1`,
    ),
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM yield_publication_generations
        WHERE state = 'published'
        ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC
        LIMIT 1`,
    ),
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM yield_publication_generations
        WHERE state = 'failed'
        ORDER BY COALESCE(failed_at, started_at) DESC, started_at DESC
        LIMIT 1`,
    ),
  ]);
  return buildSurfaceHealth(YIELD_RANKINGS_SURFACE, now, latestAttempted, latestPublished, latestFailed);
}

async function loadGenericPublicationSurface(
  db: D1Database,
  now: number,
  definition: PublicationSurfaceDefinition,
): Promise<PublicationSurfaceHealth | null> {
  const selectColumns = `
    generation_id,
    state AS source_state,
    started_at,
    validated_at,
    published_at,
    NULL AS failed_at,
    candidate_rows,
    published_rows,
    expected_rows,
    failure_reason,
    json_object(
      'inputWatermarks', CASE WHEN json_valid(input_watermarks_json) THEN json(input_watermarks_json) ELSE NULL END,
      'dependencySnapshot', CASE WHEN json_valid(dependency_snapshot_json) THEN json(dependency_snapshot_json) ELSE NULL END,
      'validationSummary', CASE WHEN json_valid(validation_summary_json) THEN json(validation_summary_json) ELSE NULL END,
      'artifactChecksum', artifact_checksum,
      'artifactCacheKey', artifact_cache_key,
      'previousGenerationId', previous_generation_id
    ) AS metadata_json`;

  const [latestAttempted, latestPublished, failedRow, rejectedRow] = await Promise.all([
    firstBoundRow(
      db,
      `SELECT ${selectColumns}
           FROM surface_publication_generations
          WHERE surface = ?
          ORDER BY started_at DESC
          LIMIT 1`,
      definition.surface,
    ),
    firstBoundRow(
      db,
      `SELECT ${selectColumns}
           FROM surface_publication_generations
          WHERE surface = ? AND state = 'published'
          ORDER BY published_at DESC, started_at DESC
          LIMIT 1`,
      definition.surface,
    ),
    firstBoundRow(
      db,
      `SELECT ${selectColumns}
           FROM surface_publication_generations
          WHERE surface = ? AND state = 'failed'
          ORDER BY started_at DESC
          LIMIT 1`,
      definition.surface,
    ),
    firstBoundRow(
      db,
      `SELECT ${selectColumns}
           FROM surface_publication_generations
          WHERE surface = ? AND state = 'rejected'
          ORDER BY started_at DESC
          LIMIT 1`,
      definition.surface,
    ),
  ]);
  const latestFailed = [failedRow, rejectedRow]
    .filter((row): row is PublicationGenerationRow => row != null)
    .sort((a, b) => b.started_at - a.started_at)[0] ?? null;

  if (latestAttempted == null && latestPublished == null && latestFailed == null) {
    return null;
  }
  return buildSurfaceHealth(definition, now, latestAttempted, latestPublished, latestFailed);
}

function stablecoinsCacheFailureRow(
  reason: string,
  updatedAt: number | null,
  now: number,
  metadata: Record<string, unknown>,
): PublicationGenerationRow {
  const attemptedAt = updatedAt ?? now;
  return {
    generation_id: updatedAt == null
      ? "stablecoins-cache:missing"
      : `stablecoins-cache:${updatedAt}:invalid`,
    source_state: "failed",
    started_at: attemptedAt,
    validated_at: null,
    published_at: null,
    failed_at: attemptedAt,
    candidate_rows: null,
    published_rows: null,
    expected_rows: null,
    failure_reason: reason,
    metadata_json: JSON.stringify(metadata),
  };
}

function publishedFallbackRow(
  generationId: string,
  publishedAt: number,
  rowCount: number | null,
  metadata: Record<string, unknown>,
): PublicationGenerationRow {
  return {
    generation_id: generationId,
    source_state: "published",
    started_at: publishedAt,
    validated_at: publishedAt,
    published_at: publishedAt,
    failed_at: null,
    candidate_rows: rowCount,
    published_rows: rowCount,
    expected_rows: null,
    failure_reason: null,
    metadata_json: JSON.stringify(metadata),
  };
}

function failedFallbackRow(
  generationId: string,
  reason: string,
  attemptedAt: number,
  metadata: Record<string, unknown>,
): PublicationGenerationRow {
  return {
    generation_id: generationId,
    source_state: "failed",
    started_at: attemptedAt,
    validated_at: null,
    published_at: null,
    failed_at: attemptedAt,
    candidate_rows: null,
    published_rows: null,
    expected_rows: null,
    failure_reason: reason,
    metadata_json: JSON.stringify(metadata),
  };
}

async function loadStablecoinsPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const genericSurface = await loadGenericPublicationSurface(db, now, STABLECOINS_SURFACE);
  if (genericSurface) return genericSurface;

  const responseReadyCacheKey = getResponseReadyCacheKey("stablecoins");
  const [stablecoinsCache, responseReadyUpdatedAt] = await Promise.all([
    loadStablecoinsCache(db, {
      mode: "strict",
      contract: "published",
    }),
    getCacheUpdatedAt(db, responseReadyCacheKey).catch(() => null),
  ]);

  const metadata = {
    cacheKey: "stablecoins",
    contract: "published",
    responseReadyCacheKey,
    responseReadyUpdatedAt,
    responseReadyMatchesCanonical:
      stablecoinsCache.updatedAt != null && responseReadyUpdatedAt === stablecoinsCache.updatedAt,
    inputWatermarks: {
      stablecoinsCache: stablecoinsCache.updatedAt,
      responseReadyCache: responseReadyUpdatedAt,
    },
  };

  if (stablecoinsCache.kind === "ok") {
    const row: PublicationGenerationRow = {
      generation_id: `stablecoins-cache:${stablecoinsCache.updatedAt}`,
      source_state: "published",
      started_at: stablecoinsCache.updatedAt,
      validated_at: stablecoinsCache.updatedAt,
      published_at: stablecoinsCache.updatedAt,
      failed_at: null,
      candidate_rows: stablecoinsCache.payload.peggedAssets.length,
      published_rows: stablecoinsCache.payload.peggedAssets.length,
      expected_rows: null,
      failure_reason: null,
      metadata_json: JSON.stringify(metadata),
    };
    return buildSurfaceHealth(STABLECOINS_CACHE_SURFACE, now, row, row, null);
  }

  const failedRow = stablecoinsCacheFailureRow(
    stablecoinsCache.reason,
    stablecoinsCache.updatedAt,
    now,
    metadata,
  );
  return buildSurfaceHealth(STABLECOINS_CACHE_SURFACE, now, failedRow, null, failedRow);
}

async function loadDewsFallbackPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const published = await loadPublishedStressSignalGeneration(db, now);
  if (published.status === "ok" && published.exactCoverageVerified) {
    const publishedRow = publishedFallbackRow(
      `dews:${published.computedAt}`,
      published.computedAt,
      published.rows.length,
      {
        inputWatermarks: {
          publishedGeneration: published.computedAt,
        },
        cacheKey: "dews:published-generation",
        exactCoverageVerified: true,
      },
    );
    return buildSurfaceHealth(DEWS_POINTER_SURFACE, now, publishedRow, publishedRow, null);
  }

  const failureReason = published.status === "ok"
    ? "legacy-publication-pointer-without-exact-coverage"
    : published.reason;
  const failedRow = failedFallbackRow(
    "dews:missing",
    failureReason,
    now,
    {
      cacheKey: "dews:published-generation",
      exactCoverageVerified: false,
    },
  );
  return buildSurfaceHealth(DEWS_POINTER_SURFACE, now, failedRow, null, failedRow);
}

async function loadDewsPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const genericSurface = await loadGenericPublicationSurface(db, now, DEWS_SURFACE);
  return genericSurface ?? loadDewsFallbackPublicationSurface(db, now);
}

async function loadPsiFallbackPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const row = await runWithOverloadRetry(() =>
    db
      .prepare(
        `SELECT stored_at, score, band, methodology_version
           FROM stability_index_samples
          ORDER BY stored_at DESC
          LIMIT 1`,
      )
      .first<{
        stored_at: number | null;
        score: number | null;
        band: string | null;
        methodology_version: string | null;
      }>(),
  2);
  if (row?.stored_at != null) {
    const publishedRow = publishedFallbackRow(
      `psi:${row.stored_at}`,
      row.stored_at,
      1,
      {
        inputWatermarks: {
          stabilityIndexSample: row.stored_at,
        },
        score: row.score,
        band: row.band,
        methodologyVersion: row.methodology_version,
      },
    );
    return buildSurfaceHealth(PSI_SAMPLE_SURFACE, now, publishedRow, publishedRow, null);
  }

  const failedRow = failedFallbackRow(
    "psi:missing",
    "missing-stability-index-sample",
    now,
    {},
  );
  return buildSurfaceHealth(PSI_SAMPLE_SURFACE, now, failedRow, null, failedRow);
}

async function loadPsiPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const genericSurface = await loadGenericPublicationSurface(db, now, PSI_SURFACE);
  return genericSurface ?? loadPsiFallbackPublicationSurface(db, now);
}

async function loadSafetyScoreV9PublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  const active = await loadActiveSafetyScoreSource(db);
  if (active.kind !== "error") {
    const snapshot = active.snapshot;
    const publishedRow = publishedFallbackRow(
      snapshot.safetyScoreIdentity.publicationGenerationId,
      snapshot.updatedAt,
      snapshot.cards.length,
      {
        inputWatermarks: {
          reportCardCache: snapshot.updatedAt,
        },
        methodologyVersion: snapshot.methodology.version,
        safetyScoreIdentity: snapshot.safetyScoreIdentity,
        completeness: snapshot.completeness,
        publicationHealth: snapshot.publicationHealth,
      },
    );
    return buildSurfaceHealth(SAFETY_SCORE_V9_SURFACE, now, publishedRow, publishedRow, null);
  }
  const attemptedAt = now;
  const failedRow = failedFallbackRow(
    `safety-score-v9:${attemptedAt}:${active.reason}`,
    active.reason,
    attemptedAt,
    {},
  );
  return buildSurfaceHealth(SAFETY_SCORE_V9_SURFACE, now, failedRow, null, failedRow);
}

const PUBLICATION_SURFACE_LOADERS: PublicationSurfaceLoader[] = [
  {
    definition: DEX_LIQUIDITY_SURFACE,
    load: loadDexLiquidityPublicationSurface,
  },
  {
    definition: YIELD_RANKINGS_SURFACE,
    load: loadYieldRankingsPublicationSurface,
  },
  {
    definition: STABLECOINS_SURFACE,
    load: loadStablecoinsPublicationSurface,
  },
  {
    definition: DEWS_SURFACE,
    load: loadDewsPublicationSurface,
  },
  {
    definition: PSI_SURFACE,
    load: loadPsiPublicationSurface,
  },
  {
    definition: SAFETY_SCORE_V9_SURFACE,
    load: loadSafetyScoreV9PublicationSurface,
  },
];

function publicationSurfaceFailure(
  surface: PublicationSurfaceId,
  error: unknown,
): PublicationSurfaceFailure {
  if (isMissingTableError(error)) {
    return {
      surface,
      code: "publication_surface_table_missing",
      message: "Publication surface storage is not available in this environment.",
    };
  }
  return {
    surface,
    code: "publication_surface_query_failed",
    message: "Publication surface query failed.",
  };
}

export async function loadPublicationHealth(db: D1Database, now: number): Promise<PublicationHealth> {
  const settled = await Promise.allSettled(
    PUBLICATION_SURFACE_LOADERS.map(async (loader) => ({
      definition: loader.definition,
      surfaceHealth: await loader.load(db, now),
    })),
  );
  const surfaces: Partial<Record<PublicationSurfaceId, PublicationSurfaceHealth>> = {};
  const failedSurfaces: PublicationSurfaceFailure[] = [];

  for (let index = 0; index < settled.length; index += 1) {
    const result = settled[index];
    const loader = PUBLICATION_SURFACE_LOADERS[index];
    if (!result || !loader) continue;
    if (result.status === "fulfilled") {
      const surfaceHealth = result.value.surfaceHealth;
      if (surfaceHealth) surfaces[result.value.definition.surface] = surfaceHealth;
      continue;
    }
    failedSurfaces.push(publicationSurfaceFailure(loader.definition.surface, result.reason));
  }

  return {
    checkedAt: now,
    surfaces,
    ...(failedSurfaces.length > 0 ? { failedSurfaces } : {}),
  };
}
