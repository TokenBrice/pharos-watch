import { describe, expect, it } from "vitest";
import { hashKey } from "@tanstack/react-query";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "@/lib/api-query-descriptors";
import { SCREENER_REFRESH_QUERY_KEYS } from "@/components/screener/screener-table";
import { STABLECOIN_TABLE_REFRESH_QUERY_KEYS } from "@/components/stablecoin-table-columns";

// The refreshing bar matches queryHash exactly, so a hand-spelled prefix such
// as ["report-cards"] can never match ["report-cards", "v9", "table", 1].
const REGISTERED_QUERY_HASHES = new Set(
  Object.values(FRONTEND_API_QUERY_DESCRIPTORS).flatMap((descriptor) =>
    typeof descriptor === "function" ? [] : [hashKey(descriptor.queryKey)],
  ),
);

const TABLES = [
  ["stablecoin table", STABLECOIN_TABLE_REFRESH_QUERY_KEYS],
  ["screener", SCREENER_REFRESH_QUERY_KEYS],
] as const;

describe("table refresh query keys", () => {
  it.each(TABLES)("registers every %s refreshing key as a query the table reads", (_label, keys) => {
    for (const key of keys) expect(REGISTERED_QUERY_HASHES.has(hashKey(key))).toBe(true);
  });

  it.each(TABLES)("covers the exact report-cards and liquidity table queries for the %s", (_label, keys) => {
    const hashes = keys.map((key) => hashKey(key));
    expect(hashes).toContain(hashKey(FRONTEND_API_QUERY_DESCRIPTORS.reportCardsV9Table.queryKey));
    expect(hashes).toContain(hashKey(FRONTEND_API_QUERY_DESCRIPTORS.dexLiquidityTable.queryKey));
  });
});
