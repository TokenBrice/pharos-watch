import { DEWS_GENERATION_CONSUMER_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import { throwIfAborted } from "./abort";
import { runWithOverloadRetry } from "./d1-overload-retry";
import {
  degradedResult,
  errorResult,
  okResult,
  skippedResult,
  unavailableResult,
} from "./canary-check-results";

/**
 * Completeness of the newest sealed public dataset. The writer's metadata is
 * the compact, persisted record of what the immutable row contains; reading it
 * avoids decompressing a multi-megabyte snapshot on every canary run while
 * still covering days sealed before the producer completeness gate shipped.
 */
interface SealedSnapshotRow {
  snapshot_date: string;
  byte_size: number | null;
  created_at: number;
}

interface PublicationEvidenceRow {
  started_at: number;
  stablecoin_count: number | null;
  dews_count: number | null;
  liquidity_count: number | null;
  dews_computed_at: number | null;
  compressed_size: number | null;
  dex_published_row_count: number | null;
  sealed_dex_row_count: number | null;
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export async function checkPublicDatasetSnapshotCompleteness(
  db: D1Database,
  _observedAt: number,
  _context: unknown,
  signal?: AbortSignal,
) {
  throwIfAborted(signal);
  try {
    const snapshot = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT /* pharos:canary:public-dataset-snapshot */
                  snapshot_date, byte_size, created_at
             FROM public_snapshots
            ORDER BY snapshot_date DESC
            LIMIT 1`,
        )
        .first<SealedSnapshotRow>(),
      3,
      signal,
    );
    throwIfAborted(signal);
    if (!snapshot) {
      return degradedResult("no sealed public snapshot found");
    }

    const evidence = await runWithOverloadRetry(
      () => db
        .prepare(
          `SELECT /* pharos:canary:public-dataset-publication */
                  started_at,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.stablecoinCount') END AS stablecoin_count,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.dewsCount') END AS dews_count,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.liquidityCount') END AS liquidity_count,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.dewsComputedAt') END AS dews_computed_at,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.compressedSize') END AS compressed_size,
                  CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.dexPublicationRowCount') END AS sealed_dex_row_count,
                  (SELECT current_row_count
                     FROM dex_liquidity_publication_generations
                    WHERE state = 'published'
                    ORDER BY COALESCE(published_at, started_at) DESC, started_at DESC
                    LIMIT 1) AS dex_published_row_count
             FROM cron_runs
            WHERE job = 'snapshot-public-dataset'
              AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.snapshotDate') END = ?
              AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.stablecoinCount') END IS NOT NULL
            ORDER BY started_at DESC, id DESC
            LIMIT 1`,
        )
        .bind(snapshot.snapshot_date)
        .first<PublicationEvidenceRow>(),
      3,
      signal,
    );
    throwIfAborted(signal);

    const metadata = {
      snapshotDate: snapshot.snapshot_date,
      createdAt: snapshot.created_at,
      byteSize: snapshot.byte_size,
      publicationStartedAt: evidence?.started_at ?? null,
      stablecoinCount: evidence?.stablecoin_count ?? null,
      dewsCount: evidence?.dews_count ?? null,
      liquidityCount: evidence?.liquidity_count ?? null,
      dewsComputedAt: evidence?.dews_computed_at ?? null,
      compressedSize: evidence?.compressed_size ?? null,
      dexPublishedRowCount: evidence?.dex_published_row_count ?? null,
      sealedDexPublicationRowCount: evidence?.sealed_dex_row_count ?? null,
    };
    if (!evidence) {
      // Older than cron_runs retention or written by another producer: the
      // sealed row exists but its publication evidence cannot be read. Do not
      // turn that absence into a healthy completeness claim.
      return skippedResult("public-snapshot-publication-metadata-unavailable", metadata);
    }
    if (!isCount(evidence.stablecoin_count) || evidence.stablecoin_count === 0) {
      return errorResult("sealed public snapshot has an empty stablecoins section", metadata);
    }
    if (!isCount(evidence.dews_count) || evidence.dews_count === 0) {
      return errorResult("sealed public snapshot has an empty DEWS section", metadata);
    }
    if (metadata.byteSize == null || metadata.byteSize <= 0) {
      return degradedResult("sealed public snapshot has no payload bytes", metadata);
    }
    if (
      evidence.dews_computed_at != null
      && Number.isFinite(evidence.dews_computed_at)
      && evidence.started_at - evidence.dews_computed_at > DEWS_GENERATION_CONSUMER_MAX_AGE_SEC
    ) {
      return degradedResult(
        `sealed DEWS generation exceeded its ${DEWS_GENERATION_CONSUMER_MAX_AGE_SEC}s consumer budget ` +
          `(${Math.max(0, evidence.started_at - evidence.dews_computed_at)}s)`,
        metadata,
      );
    }
    // The sealed row is immutable: compare it with the generation the producer
    // read at seal time. A later published generation may legitimately grow.
    // Pre-gate rows carry no sealed count, so fall back to the live generation.
    const comparisonRowCount = isCount(evidence.sealed_dex_row_count)
      ? evidence.sealed_dex_row_count
      : evidence.dex_published_row_count;
    if (
      isCount(comparisonRowCount)
      && comparisonRowCount > 0
      && (!isCount(evidence.liquidity_count) || evidence.liquidity_count < comparisonRowCount)
    ) {
      return degradedResult(
        `sealed liquidity section has ${metadata.liquidityCount ?? "no"} rows for a ` +
          `${comparisonRowCount}-row published generation`,
        metadata,
      );
    }
    return okResult(metadata);
  } catch (error) {
    return unavailableResult(error);
  }
}
