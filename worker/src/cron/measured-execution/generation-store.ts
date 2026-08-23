import { executeAtomicBatch } from "../../lib/db";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { parseJson } from "../../lib/json-parse";
export const DEX_MEASURED_TARGET_SURFACE = "dex-measured-execution-targets";
export const DEX_MEASURED_QUOTE_SURFACE = "dex-measured-execution-quotes";
export const DEX_SHADOW_MEASURED_TARGET_SURFACE = "dex-shadow-measured-execution-targets";
export const DEX_SHADOW_MEASURED_QUOTE_SURFACE = "dex-shadow-measured-execution-quotes";

export function parsePersistedJson(value: string, context: string): unknown {
  const parsed = parseJson(value, { onFailure: () => undefined });
  if (!parsed.ok) throw new Error(`Invalid ${context}: ${parsed.message}`);
  return parsed.value;
}

export interface SurfaceGenerationRow {
  generation_id: string;
  state: string;
  started_at: number;
  published_at: number | null;
  expected_rows: number | null;
  published_rows: number | null;
  dependency_snapshot_json: string | null;
}

export interface MeasuredQuoteGenerationDependency {
  targetGenerationId?: string;
  targetCount?: number;
  persistedOutcomeCount?: number;
  omittedBudgetDeferredCount?: number;
  targetIdsSha256?: string;
}

export function measuredGenerationId(prefix: string, nowSec: number): string {
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  return `${prefix}-${nowSec}-${nonce}`;
}

export async function hashMeasuredTargetIds(targetIds: readonly string[]): Promise<string> {
  const canonical = JSON.stringify([...targetIds].sort());
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildDexMeasuredQuoteGenerationId(nowSec: number): string {
  return measuredGenerationId("dex-measured-quotes", nowSec);
}

export function buildDexShadowMeasuredQuoteGenerationId(nowSec: number): string {
  return measuredGenerationId("dex-shadow-measured-quotes", nowSec);
}

export async function latestPublishedGeneration(
  db: D1Database,
  surface: string,
  signal?: AbortSignal,
): Promise<SurfaceGenerationRow | null> {
  return runWithOverloadRetry(
    () =>
      db
        .prepare(
          `SELECT generation_id, state, started_at, published_at, expected_rows, published_rows, dependency_snapshot_json
       FROM surface_publication_generations
       WHERE surface = ? AND state = 'published'
       ORDER BY published_at DESC, started_at DESC
       LIMIT 1`,
        )
        .bind(surface)
        .first<SurfaceGenerationRow>(),
    3,
    signal,
  );
}

/** Superseded quote generations inside the lookback whose row count still matches the published ledger, newest first. */
export async function loadSupersededQuoteGenerationIds(input: {
  db: D1Database;
  quoteSurface: string;
  publishedAtFloor: number;
  signal?: AbortSignal;
}): Promise<string[]> {
  const result = await runWithOverloadRetry(
    () =>
      input.db
        .prepare(
          `SELECT history_generation.generation_id
       FROM surface_publication_generations history_generation
       WHERE history_generation.surface = ? AND history_generation.state = 'superseded'
         AND history_generation.published_at IS NOT NULL AND history_generation.published_at >= ?
         AND history_generation.expected_rows IS NOT NULL
         AND history_generation.published_rows = history_generation.expected_rows
         AND history_generation.expected_rows = (
           SELECT COUNT(*)
           FROM dex_measured_execution_quotes complete_quotes
           WHERE complete_quotes.generation_id = history_generation.generation_id
         )
       ORDER BY history_generation.published_at DESC, history_generation.generation_id DESC`,
        )
        .bind(input.quoteSurface, input.publishedAtFloor)
        .all<{ generation_id: string }>(),
    3,
    input.signal,
  );
  return (result.results ?? []).map((row) => row.generation_id);
}

export async function markGenerationFailed(db: D1Database, surface: string, id: string, reason: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE surface_publication_generations
       SET state = 'failed', failure_reason = ?
       WHERE surface = ? AND generation_id = ? AND state IN ('candidate', 'validated')`,
      )
      .bind(reason.slice(0, 500), surface, id)
      .run();
  } catch {
    // The original publication error remains authoritative.
  }
}

export async function publishGenerationPointer(input: {
  db: D1Database;
  surface: string;
  generationId: string;
  previousGenerationId: string | null;
  nowSec: number;
  rowCount: number;
  validationSummary: unknown;
  signal?: AbortSignal;
}): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  const previousGuard =
    input.previousGenerationId == null
      ? ""
      : ` AND EXISTS (
          SELECT 1 FROM surface_publication_generations
          WHERE surface = ? AND generation_id = ? AND state = 'published'
        )`;
  statements.push(
    input.db
      .prepare(
        `UPDATE surface_publication_generations
     SET state = 'published', validated_at = ?, published_at = ?, published_rows = ?, validation_summary_json = ?
     WHERE surface = ? AND generation_id = ? AND state = 'candidate'${previousGuard}`,
      )
      .bind(
        input.nowSec,
        input.nowSec,
        input.rowCount,
        JSON.stringify(input.validationSummary),
        input.surface,
        input.generationId,
        ...(input.previousGenerationId == null ? [] : [input.surface, input.previousGenerationId]),
      ),
  );
  if (input.previousGenerationId != null) {
    statements.push(
      input.db
        .prepare(
          `UPDATE surface_publication_generations
       SET state = 'superseded'
       WHERE surface = ? AND generation_id = ? AND state = 'published'
         AND EXISTS (
           SELECT 1 FROM surface_publication_generations
           WHERE surface = ? AND generation_id = ? AND state = 'published'
         )`,
        )
        .bind(input.surface, input.previousGenerationId, input.surface, input.generationId),
    );
  }
  const changes = await executeAtomicBatch(input.db, statements, { signal: input.signal });
  const expectedChanges = input.previousGenerationId == null ? 1 : 2;
  if (changes !== expectedChanges) {
    throw new Error(`Publication pointer update failed for ${input.surface}/${input.generationId}`);
  }
}
