import { getCache } from "./db-cache";

const SNAPSHOT_SUPPLY_LAST_WRITE_KEY = "snapshot-supply:last-write";

export async function getCompletedSupplySnapshotDate(db: D1Database): Promise<number | null> {
  const cached = await getCache(db, SNAPSHOT_SUPPLY_LAST_WRITE_KEY);
  if (!cached) return null;

  try {
    const parsed = JSON.parse(cached.value) as { snapshotDate?: unknown };
    return typeof parsed.snapshotDate === "number" && Number.isFinite(parsed.snapshotDate)
      ? parsed.snapshotDate
      : null;
  } catch {
    return null;
  }
}
