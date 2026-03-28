import type { CronResult } from "./cron-logger";

export function normalizeCronMetadata(
  result: CronResult | null | void,
  extras: Record<string, unknown> = {},
): string {
  const parsed: Record<string, unknown> = {};
  if (result?.metadata) {
    try {
      Object.assign(parsed, JSON.parse(result.metadata) as Record<string, unknown>);
    } catch {
      parsed.rawMetadata = result.metadata;
    }
  }

  const rowsWrittenDefault = typeof result?.itemCount === "number" ? result.itemCount : null;

  return JSON.stringify({
    rowsRead: parsed.rowsRead ?? null,
    rowsWritten: parsed.rowsWritten ?? rowsWrittenDefault,
    rowsDropped: parsed.rowsDropped ?? 0,
    sourceCoverage: parsed.sourceCoverage ?? null,
    fallbackMode: parsed.fallbackMode ?? null,
    validationFailures: parsed.validationFailures ?? 0,
    ...parsed,
    ...extras,
  });
}
