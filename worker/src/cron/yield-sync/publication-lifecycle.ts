import type { YieldPublicationMetadata } from "@shared/types/yield";
import { batchExecute } from "../../lib/db";
import { getCache } from "../../lib/db-cache";
import { buildYieldMethodology } from "./publication-methodology";

export function buildYieldPublicationGenerationId(startSec: number): string {
  return `yield-${startSec}`;
}

function buildYieldPublicationMetadata(params: {
  generationId: string;
  startSec: number;
  status: YieldPublicationMetadata["status"];
}): YieldPublicationMetadata {
  return {
    generationId: params.generationId,
    updatedAt: params.startSec,
    cutoffAt: params.startSec,
    schemaVersion: 1,
    status: params.status,
  };
}

export function attachYieldPublicationMetadata<
  T extends {
    rankings?: Array<Record<string, unknown>>;
    updatedAt?: number;
    methodology?: unknown;
  },
>(
  payload: T,
  params: {
    generationId: string;
    startSec: number;
    status: YieldPublicationMetadata["status"];
  },
): T & { publication: YieldPublicationMetadata } {
  const updatedAt = typeof payload.updatedAt === "number" && Number.isFinite(payload.updatedAt)
    ? payload.updatedAt
    : params.startSec;
  return {
    ...payload,
    methodology: payload.methodology ?? buildYieldMethodology(updatedAt),
    publication: buildYieldPublicationMetadata(params),
    rankings: Array.isArray(payload.rankings)
      ? payload.rankings.map((ranking, index) => ({
          ...ranking,
          publicationGenerationId: params.generationId,
          publishedRank: index + 1,
        }))
      : payload.rankings,
  };
}

export async function stageYieldPublicationGeneration(
  db: D1Database,
  params: {
    generationId: string;
    startSec: number;
    rankingCount: number;
    sourceRowCount: number;
    bestRowCount: number;
    rowsRejected: number;
    divergenceFlags: number;
    sourceSwitches: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO yield_publication_generations (
        generation_id, started_at, state, cache_key, ranking_updated_at, ranking_count,
        source_row_count, best_row_count, decision_count, metadata_json, created_at
      ) VALUES (?, ?, 'staged', 'yield-rankings', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      params.generationId,
      params.startSec,
      params.startSec,
      params.rankingCount,
      params.sourceRowCount,
      params.bestRowCount,
      params.bestRowCount,
      JSON.stringify({
        rowsRejected: params.rowsRejected,
        divergenceFlags: params.divergenceFlags,
        sourceSwitches: params.sourceSwitches,
      }),
      params.startSec,
    )
    .run();
}

export async function finalizeYieldPublicationGeneration(
  db: D1Database,
  params: {
    generationId: string;
    state: "published" | "failed";
    timestamp: number;
    reason?: string;
  },
): Promise<void> {
  const rowState = params.state;
  const generationStmt =
    params.state === "published"
      ? db
          .prepare(
            `UPDATE yield_publication_generations
             SET state = 'published', published_at = ?, failed_at = NULL, failure_reason = NULL
             WHERE generation_id = ?`,
          )
          .bind(params.timestamp, params.generationId)
      : db
          .prepare(
            `UPDATE yield_publication_generations
             SET state = 'failed', failed_at = ?, failure_reason = ?
             WHERE generation_id = ?`,
          )
          .bind(params.timestamp, params.reason ?? "publication-failed", params.generationId);

  await batchExecute(db, [
    generationStmt,
    db
      .prepare("UPDATE yield_data SET publication_state = ? WHERE publication_generation_id = ?")
      .bind(rowState, params.generationId),
    db
      .prepare("UPDATE yield_history SET publication_state = ? WHERE publication_generation_id = ?")
      .bind(rowState, params.generationId),
  ]);
}

function parsePublishedYieldPublicationMetadata(
  cached: { value: string; updatedAt: number } | null,
): YieldPublicationMetadata | null {
  if (!cached) return null;
  try {
    const payload = JSON.parse(cached.value) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const publication = (payload as { publication?: unknown }).publication;
    if (!publication || typeof publication !== "object" || Array.isArray(publication)) return null;
    const generationId = (publication as { generationId?: unknown }).generationId;
    const status = (publication as { status?: unknown }).status;
    if (typeof generationId !== "string" || generationId.length === 0 || status !== "published") return null;
    const updatedAt = (publication as { updatedAt?: unknown }).updatedAt;
    const cutoffAt = (publication as { cutoffAt?: unknown }).cutoffAt;
    return {
      generationId,
      status: "published",
      updatedAt: typeof updatedAt === "number" && Number.isFinite(updatedAt) ? updatedAt : cached.updatedAt,
      cutoffAt: typeof cutoffAt === "number" && Number.isFinite(cutoffAt) ? cutoffAt : cached.updatedAt,
      schemaVersion: 1,
    };
  } catch {
    return null;
  }
}

export async function repairPublishedYieldGenerationFromCache(
  db: D1Database,
  timestamp: number,
): Promise<boolean> {
  const cached = await getCache(db, "yield-rankings");
  const publication = parsePublishedYieldPublicationMetadata(cached);
  if (!publication?.generationId) return false;
  await finalizeYieldPublicationGeneration(db, {
    generationId: publication.generationId,
    state: "published",
    timestamp,
  });
  return true;
}
