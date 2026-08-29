import { safeJsonParse } from "../lib/api-cache-read";
import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../lib/structured-log";

export interface AdminAuditPageDescriptor<TRow, TEntry> {
  unfilteredSql: string;
  filteredSql?: string;
  detailJson: (row: TRow) => string | null;
  rowId: (row: TRow) => number;
  malformedDetailLog: "cache" | "api-key";
  detailContext: string;
  mapRow: (row: TRow, detail: unknown) => TEntry;
}

interface AdminAuditPageOptions<TRow, TEntry> {
  descriptor: AdminAuditPageDescriptor<TRow, TEntry>;
  limit: number;
  filterValue?: number;
}

function parseDetail<TRow, TEntry>(
  row: TRow,
  descriptor: AdminAuditPageDescriptor<TRow, TEntry>,
): unknown {
  const raw = descriptor.detailJson(row);
  if (!raw) return null;
  if (descriptor.malformedDetailLog === "cache") {
    return safeJsonParse<unknown>(raw, null, `${descriptor.detailContext}:${descriptor.rowId(row)}:details_json`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    logWorkerEventArgs("api", "warn",
      `[${descriptor.detailContext}] Failed to parse detail_json for row ${descriptor.rowId(row)}:`,
      toErrorMessage(error),
    );
    return null;
  }
}

export async function loadAdminAuditPage<TRow, TEntry>(
  db: D1Database,
  options: AdminAuditPageOptions<TRow, TEntry>,
): Promise<TEntry[]> {
  const { descriptor, filterValue, limit } = options;
  const statement = filterValue == null
    ? db.prepare(descriptor.unfilteredSql).bind(limit)
    : db.prepare(descriptor.filteredSql!).bind(filterValue, limit);
  const result = await statement.all<TRow>();
  return (result.results ?? []).map((row) => descriptor.mapRow(row, parseDetail(row, descriptor)));
}
