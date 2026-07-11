import { batchExecute } from "../../lib/db";

const FAILURE_SAMPLE_LIMIT = 4;
const FAILURE_SAMPLE_MAX_LENGTH = 120;
const RETENTION_SEC = 14 * 24 * 60 * 60;

export type BlacklistProviderScanTelemetry = {
  configKey: string;
  chainId: string;
  providerMode: "trongrid" | "etherscan" | "rpc" | "rpc-or-topics" | "exception";
  coverageOutcome: string;
  fromCursor: number;
  scannedToCursor: number | null;
  safeHead: number | null;
  fetchedRowCount: number;
  insertedRowCount: number;
  providerCallCount: number;
  maxSplitDepth: number;
  failureSamples: readonly string[];
  observedAt: number;
};

export function boundBlacklistProviderFailureSamples(samples: readonly string[]): string[] {
  return samples
    .slice(0, FAILURE_SAMPLE_LIMIT)
    .map((sample) => sample.replace(/[\r\n]+/g, " ").slice(0, FAILURE_SAMPLE_MAX_LENGTH));
}

export async function persistBlacklistProviderScanTelemetry(
  db: D1Database,
  rows: readonly BlacklistProviderScanTelemetry[],
  now: number,
  signal?: AbortSignal,
): Promise<number> {
  if (rows.length === 0) return 0;
  const statements = rows.map((row) =>
    db
      .prepare(
        `/* blacklist-provider-scan-telemetry-insert */
         INSERT INTO blacklist_provider_scan_telemetry
           (config_key, chain_id, provider_mode, coverage_outcome, from_cursor,
            scanned_to_cursor, safe_head, fetched_row_count, inserted_row_count,
            provider_call_count, max_split_depth, failure_samples_json, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        row.configKey,
        row.chainId,
        row.providerMode,
        row.coverageOutcome,
        row.fromCursor,
        row.scannedToCursor,
        row.safeHead,
        row.fetchedRowCount,
        row.insertedRowCount,
        row.providerCallCount,
        row.maxSplitDepth,
        JSON.stringify(boundBlacklistProviderFailureSamples(row.failureSamples)),
        row.observedAt,
      ),
  );
  statements.push(
    db
      .prepare(
        `/* blacklist-provider-scan-telemetry-prune */
         DELETE FROM blacklist_provider_scan_telemetry
         WHERE observed_at < ?`,
      )
      .bind(now - RETENTION_SEC),
  );
  await batchExecute(db, statements, { signal });
  return rows.length;
}
