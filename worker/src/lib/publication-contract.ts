import type {
  PublicationGenerationHealth,
  PublicationGenerationState,
  PublicationHealth,
  PublicationSurfaceHealth,
  PublicationSurfaceId,
} from "@shared/types/status";
import { runWithOverloadRetry } from "./d1-overload-retry";

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

function parseMetadata(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return { raw: value.slice(0, 1_000) };
  }
}

function mapSourceState(state: string): PublicationGenerationState {
  if (state === "staged") return "candidate";
  if (state === "published") return "published";
  if (state === "failed") return "failed";
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
  const metadata = parseMetadata(row.metadata_json);
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

export async function loadPublicationHealth(db: D1Database, now: number): Promise<PublicationHealth> {
  const [dexLiquidity, yieldRankings] = await Promise.all([
    loadDexLiquidityPublicationSurface(db, now),
    loadYieldRankingsPublicationSurface(db, now),
  ]);
  return {
    checkedAt: now,
    surfaces: {
      "dex-liquidity": dexLiquidity,
      "yield-rankings": yieldRankings,
    },
  };
}
