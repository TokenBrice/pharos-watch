import { toErrorMessage } from "@shared/lib/error-utils";
import { DexLiquidityCronMetadataSchema, type DexLiquidityCronMetadata } from "./schemas";
import { logWorkerEventArgs } from "./structured-log";

export type ParsedPreviousCronRow = {
  id: number;
  startedAt: number | null;
  status: string | null;
  metadata: DexLiquidityCronMetadata;
};

export class DexLiquidityCronHistoryInconclusiveError extends Error {
  constructor() {
    super("Unable to establish validated DEX liquidity cron history");
  }
}

function parseDexLiquidityCronMetadata(metadata: string | null): DexLiquidityCronMetadata | null {
  if (!metadata) return null;
  try {
    return DexLiquidityCronMetadataSchema.parse(JSON.parse(metadata));
  } catch (err) {
    logWorkerEventArgs("handler", "warn",
      "[dex-liquidity] Failed to parse previous cron metadata:",
      toErrorMessage(err),
    );
    return null;
  }
}

/** The scoring and retention paths must agree on which terminal rows can carry anchor state. */
export async function readDexLiquidityCronHistory(db: D1Database): Promise<ParsedPreviousCronRow[]> {
  const pageSize = 12;
  const parsedRows: ParsedPreviousCronRow[] = [];
  let cursor = { started_at: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER };
  // Bound D1 work when a metadata change makes every recent row unreadable.
  for (let page = 0; page < 8; page++) {
    const read = await db.prepare(
      `SELECT started_at, status, metadata, id
       FROM cron_runs
       WHERE job = 'sync-dex-liquidity'
         AND status IN ('ok', 'degraded')
         AND metadata IS NOT NULL
         AND json_type(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.persistence.skipped') IS NOT 'true'
         AND (started_at, id) < (?, ?)
       ORDER BY started_at DESC, id DESC
       LIMIT ?`,
    ).bind(cursor.started_at, cursor.id, pageSize)
      .all<{ id: number; started_at: number; status: string | null; metadata: string | null }>();
    if (!read.success) throw new Error("Unable to read DEX liquidity cron history");
    for (const row of read.results) {
      const metadata = parseDexLiquidityCronMetadata(row.metadata);
      if (!metadata) continue;
      parsedRows.push({ id: row.id, startedAt: Number.isFinite(row.started_at) ? row.started_at : null, status: row.status, metadata });
      if (parsedRows.length === pageSize) return parsedRows;
    }
    if (read.results.length < pageSize) {
      if (parsedRows.length > 0 || (page === 0 && read.results.length === 0)) return parsedRows;
      break;
    }
    cursor = read.results[pageSize - 1];
  }
  throw new DexLiquidityCronHistoryInconclusiveError();
}

/** A run that produced a scoring result: `ok`/`degraded` and not persistence-skipped. */
export function isProductiveCronRow(row: ParsedPreviousCronRow): boolean {
  return (row.status === "ok" || row.status === "degraded") && row.metadata.persistence?.skipped !== true;
}
