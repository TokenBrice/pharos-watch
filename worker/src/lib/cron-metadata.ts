import type { CronResult } from "./cron-logger";

/**
 * Normalizes a job's metadata and merges the bounded scheduler/lease identity
 * in one pass. Producer evidence is left intact: the persistence boundary
 * compacts only audited diagnostics after scheduler/lease enrichment.
 */
export function normalizeCronMetadataWithLease(
  result: CronResult | null | void,
  leaseMeta: Record<string, unknown>,
): string {
  const parsed: Record<string, unknown> = {};
  if (result?.metadata) {
    try {
      Object.assign(parsed, JSON.parse(result.metadata) as Record<string, unknown>);
    } catch {
      parsed.rawMetadata = result.metadata;
    }
  }

  // Only producers can report measurements; itemCount is not a write count.
  const metadata = {
    ...parsed,
    rowsRead: parsed.rowsRead ?? null,
    rowsWritten: parsed.rowsWritten ?? null,
    rowsDropped: parsed.rowsDropped ?? null,
    sourceCoverage: parsed.sourceCoverage ?? null,
    fallbackMode: parsed.fallbackMode ?? null,
    validationFailures: parsed.validationFailures ?? null,
  };
  return JSON.stringify({ ...metadata, ...leaseMeta });
}
