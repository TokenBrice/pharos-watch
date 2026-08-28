import type {
  PublicationSurfaceFailure,
  PublicationGenerationHealth,
  PublicationGenerationState,
  PublicationHealth,
  PublicationSurfaceHealth,
  PublicationSurfaceId,
} from "@shared/types/status";
import { runWithOverloadRetry } from "./d1-overload-retry";
import { isMissingTableError } from "./db";
import { parseObjectMetadata } from "./json-metadata";
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

interface PublicationLifecycleDescriptor {
  definition: PublicationSurfaceDefinition;
  table: "dex_liquidity_publication_generations" | "yield_publication_generations";
  candidateRowsColumn: "written_row_count" | "source_row_count";
  publishedRowsColumn: "current_row_count" | "ranking_count";
  expectedRowsColumn: "expected_row_count" | "best_row_count";
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

const PUBLICATION_LIFECYCLE_DESCRIPTORS = {
  dexLiquidity: {
    definition: DEX_LIQUIDITY_SURFACE,
    table: "dex_liquidity_publication_generations",
    candidateRowsColumn: "written_row_count",
    publishedRowsColumn: "current_row_count",
    expectedRowsColumn: "expected_row_count",
  },
  yieldRankings: {
    definition: YIELD_RANKINGS_SURFACE,
    table: "yield_publication_generations",
    candidateRowsColumn: "source_row_count",
    publishedRowsColumn: "ranking_count",
    expectedRowsColumn: "best_row_count",
  },
} as const satisfies Record<string, PublicationLifecycleDescriptor>;

const STABLECOINS_SURFACE: PublicationSurfaceDefinition = {
  surface: "stablecoins",
  label: "Stablecoins cache",
  sourceOfTruth: "surface_publication_generations",
};

const DEWS_SURFACE: PublicationSurfaceDefinition = {
  surface: "dews",
  label: "DEWS risk signals",
  sourceOfTruth: "surface_publication_generations",
};

const PSI_SURFACE: PublicationSurfaceDefinition = {
  surface: "psi",
  label: "PSI samples",
  sourceOfTruth: "surface_publication_generations",
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

async function loadPublicationLifecycleSurface(
  db: D1Database,
  now: number,
  descriptor: PublicationLifecycleDescriptor,
): Promise<PublicationSurfaceHealth> {
  const selectColumns = `
    generation_id,
    state AS source_state,
    started_at,
    NULL AS validated_at,
    published_at,
    failed_at,
    ${descriptor.candidateRowsColumn} AS candidate_rows,
    ${descriptor.publishedRowsColumn} AS published_rows,
    ${descriptor.expectedRowsColumn} AS expected_rows,
    failure_reason,
    metadata_json`;
  const [latestAttempted, latestPublished, latestFailed] = await Promise.all([
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM ${descriptor.table}
        ORDER BY started_at DESC
        LIMIT 1`,
    ),
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM ${descriptor.table}
        WHERE state = 'published'
        ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC
        LIMIT 1`,
    ),
    firstRow(
      db,
      `SELECT ${selectColumns}
         FROM ${descriptor.table}
        WHERE state = 'failed'
        ORDER BY COALESCE(failed_at, started_at) DESC, started_at DESC
        LIMIT 1`,
    ),
  ]);
  return buildSurfaceHealth(descriptor.definition, now, latestAttempted, latestPublished, latestFailed);
}

async function loadDexLiquidityPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  return loadPublicationLifecycleSurface(db, now, PUBLICATION_LIFECYCLE_DESCRIPTORS.dexLiquidity);
}

async function loadYieldRankingsPublicationSurface(
  db: D1Database,
  now: number,
): Promise<PublicationSurfaceHealth> {
  return loadPublicationLifecycleSurface(db, now, PUBLICATION_LIFECYCLE_DESCRIPTORS.yieldRankings);
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
    load: (db, now) => loadGenericPublicationSurface(db, now, STABLECOINS_SURFACE),
  },
  {
    definition: DEWS_SURFACE,
    load: (db, now) => loadGenericPublicationSurface(db, now, DEWS_SURFACE),
  },
  {
    definition: PSI_SURFACE,
    load: (db, now) => loadGenericPublicationSurface(db, now, PSI_SURFACE),
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
