import { getCache } from "./db-cache";

const SNAPSHOT_SUPPLY_LAST_WRITE_KEY = "snapshot-supply:last-write";

export interface CompletedSupplySnapshot {
  snapshotDate: number;
  updatedAt: number;
  exactCoverageVerified: boolean;
}

export async function getCompletedSupplySnapshot(db: D1Database): Promise<CompletedSupplySnapshot | null> {
  const cached = await getCache(db, SNAPSHOT_SUPPLY_LAST_WRITE_KEY);
  if (!cached) return null;

  try {
    const parsed = JSON.parse(cached.value) as {
      snapshotDate?: unknown;
      coverageVersion?: unknown;
      expectedActiveCount?: unknown;
      accountedActiveCount?: unknown;
      writtenRows?: unknown;
    };
    return typeof parsed.snapshotDate === "number" && Number.isFinite(parsed.snapshotDate)
      ? {
          snapshotDate: parsed.snapshotDate,
          updatedAt: cached.updatedAt,
          exactCoverageVerified:
            parsed.coverageVersion === 1
            && typeof parsed.expectedActiveCount === "number"
            && typeof parsed.accountedActiveCount === "number"
            && parsed.expectedActiveCount === parsed.accountedActiveCount,
        }
      : null;
  } catch {
    return null;
  }
}
