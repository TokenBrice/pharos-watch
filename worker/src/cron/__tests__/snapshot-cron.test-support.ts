import { mockD1, type MockD1Database, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import { buildSupplySnapshotCoverageExpectation } from "../../lib/supply-snapshot-completion";
import type { StablecoinPublicationWaiver } from "../../lib/stablecoin-publication-coverage";

export type { MockD1Database, MockTableConfig };

export type StablecoinsCacheTableOptions = {
  assets: unknown;
  updatedAt: number;
  key?: string;
  first?: boolean;
};

export type SnapshotCacheTableOptions = {
  key: string;
  value: unknown;
  updatedAt: number;
  first?: boolean;
};

export type SnapshotCacheRow = {
  key: string;
  value: unknown;
  updatedAt: number;
};

export function snapshotCacheTable({
  key,
  value,
  updatedAt,
  first = true,
}: SnapshotCacheTableOptions): MockTableConfig {
  const row = {
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
    updated_at: updatedAt,
  };
  return {
    match: "SELECT value, updated_at FROM cache WHERE key = ?",
    matchBinds: [key],
    rows: first ? [] : [row],
    ...(first ? { first: row } : {}),
  };
}

export function snapshotCacheRows(rows: readonly SnapshotCacheRow[]): MockTableConfig {
  return {
    match: "FROM cache WHERE key",
    rows: rows.map(({ key, value, updatedAt }) => ({
      key,
      value: typeof value === "string" ? value : JSON.stringify(value),
      updated_at: updatedAt,
    })),
  };
}

export function stablecoinsCacheTable({
  assets,
  updatedAt,
  key = "stablecoins",
  first = true,
}: StablecoinsCacheTableOptions): MockTableConfig {
  return snapshotCacheTable({ key, value: assets, updatedAt, first });
}

export function makeSnapshotAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "usdt-tether",
    symbol: "USDT",
    name: "Tether",
    price: 1,
    pegType: "peggedUSD",
    circulating: { peggedUSD: 100 },
    chains: [],
    ...overrides,
  };
}

export type SnapshotCompletionMarkerOptions = {
  snapshotDate: number;
  requiredIds?: readonly string[];
  appliedWaivers?: readonly StablecoinPublicationWaiver[];
  ownedRowIds?: readonly string[];
  written?: { field: "writtenRows" | "writtenChains"; count: number };
  defaultOwnedRowIds?: readonly string[];
};

export function buildSnapshotCompletionMarker({
  snapshotDate,
  requiredIds = ["usdt-tether", "usdc-circle"],
  appliedWaivers = [],
  ownedRowIds,
  written,
  defaultOwnedRowIds = requiredIds,
}: SnapshotCompletionMarkerOptions): string {
  const expectation = buildSupplySnapshotCoverageExpectation(requiredIds, appliedWaivers);
  const marker = {
    snapshotDate,
    coverageVersion: 2,
    expectedActiveCount: expectation.expectedActiveCount,
    accountedActiveCount: expectation.expectedActiveCount,
    coverageDigest: expectation.coverageDigest,
    ownedRowIds: [...(ownedRowIds ?? defaultOwnedRowIds)].sort(),
    [written?.field ?? "writtenRows"]: written?.count ?? requiredIds.length,
  };
  return JSON.stringify(marker);
}

export type SupplyCompletionMarkerOptions = Omit<SnapshotCompletionMarkerOptions, "written" | "defaultOwnedRowIds"> & {
  writtenRows?: number;
};

export function buildSupplySnapshotCompletionMarker({
  snapshotDate,
  requiredIds = ["usdt-tether", "usdc-circle"],
  appliedWaivers,
  ownedRowIds,
  writtenRows = requiredIds.length,
}: SupplyCompletionMarkerOptions): string {
  return buildSnapshotCompletionMarker({
    snapshotDate,
    requiredIds,
    appliedWaivers,
    ownedRowIds,
    written: { field: "writtenRows", count: writtenRows },
  });
}

export type ChainSupplyCompletionMarkerOptions = Omit<SnapshotCompletionMarkerOptions, "written" | "defaultOwnedRowIds"> & {
  writtenChains?: number;
};

export function buildChainSupplySnapshotCompletionMarker({
  snapshotDate,
  requiredIds = ["usdt-tether", "usdc-circle"],
  appliedWaivers,
  ownedRowIds,
  writtenChains = 3,
}: ChainSupplyCompletionMarkerOptions): string {
  return buildSnapshotCompletionMarker({
    snapshotDate,
    requiredIds,
    appliedWaivers,
    ownedRowIds,
    defaultOwnedRowIds: ["bsc", "citrea", "ethereum"],
    written: { field: "writtenChains", count: writtenChains },
  });
}

export type SnapshotDbOptions = {
  tables?: MockTableConfig[];
  stablecoins?: StablecoinsCacheTableOptions;
  cacheRows?: readonly SnapshotCacheTableOptions[];
};

function snapshotDbTables(input: MockTableConfig[] | SnapshotDbOptions): MockTableConfig[] {
  if (Array.isArray(input)) return input;
  return [
    ...(input.stablecoins ? [stablecoinsCacheTable(input.stablecoins)] : []),
    ...(input.cacheRows ?? []).map((row) => snapshotCacheTable(row)),
    ...(input.tables ?? []),
  ];
}

export function makeSupplySnapshotDb(input: MockTableConfig[] | SnapshotDbOptions = []): MockD1Database {
  return mockD1([
    ...snapshotDbTables(input),
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "FROM supply_history WHERE snapshot_date", rows: [] },
    { match: "UPDATE supply_history SET price", rows: [] },
    { match: "DELETE FROM supply_history", rows: [] },
    { match: "INSERT OR REPLACE INTO supply_history", rows: [] },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
  ]);
}

export function makeChainSupplySnapshotDb(input: MockTableConfig[] | SnapshotDbOptions = []): MockD1Database {
  return mockD1([
    ...snapshotDbTables(input),
    { match: "SELECT value, updated_at FROM cache WHERE key = ?", rows: [], first: null },
    { match: "INSERT OR REPLACE INTO cache", rows: [] },
    { match: "DELETE FROM chain_supply_history", rows: [] },
    { match: "INSERT OR REPLACE INTO chain_supply_history", rows: [] },
  ]);
}

export function makePsiSnapshotDb(input: MockTableConfig[] = []): MockD1Database {
  return mockD1([...input, { match: "INSERT OR REPLACE INTO stability_index", rows: [] }]);
}

export type PsiAverageRow = {
  avg_score: number | null;
  avg_severity: number | null;
  avg_breadth: number | null;
  avg_stress_breadth: number | null;
  avg_trend: number | null;
  cnt: number;
};

export type PsiMethodologyRow = {
  methodology_version: string;
  cnt: number;
};

export function makePsiDailyDb({
  average,
  methodologyRows,
}: {
  average: PsiAverageRow;
  methodologyRows: readonly PsiMethodologyRow[];
}): MockD1Database {
  return makePsiSnapshotDb([
    { match: "AVG(score) as avg_score", rows: [], first: average },
    { match: "GROUP BY methodology_version", rows: [...methodologyRows] },
  ]);
}

export function makePublicDatasetDb(tables: MockTableConfig[] = []): MockD1Database {
  return mockD1([...tables, { match: "FROM public_snapshots WHERE snapshot_date", rows: [], first: null }]);
}
