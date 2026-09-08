import { mockD1 } from "@shared/test-utils/mock-d1";

export function freshnessDb(options: {
  cacheRows?: Record<string, unknown>[];
  tableAge?: number | null;
  pointer?: Record<string, unknown> | null;
  cronRows?: Record<string, unknown>[];
  cacheError?: Error;
  cronError?: Error;
} = {}) {
  return mockD1([
    { match: "cache WHERE key IN", rows: options.cacheRows ?? [], throwError: options.cacheError },
    { match: "FROM cache WHERE key = ?", rows: [], first: options.pointer ?? null },
    { match: "FROM dex_liquidity", rows: [{ age: options.tableAge ?? null }] },
    { match: "FROM yield_data", rows: [{ age: options.tableAge ?? null }] },
    { match: "GROUP BY job", rows: options.cronRows ?? [], throwError: options.cronError },
  ], { requireMatch: true });
}
