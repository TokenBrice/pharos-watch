const DAY = 86400;
const MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC = 14 * DAY;

export interface PsiDepegEventRow {
  stablecoin_id: string;
  peak_deviation_bps: number;
  peg_reference: number;
  started_at: number;
  ended_at: number | null;
}

export interface PsiSupplyRow {
  stablecoin_id: string;
  snapshot_date: number;
  circulating_usd: number;
}

export interface SupplySnapshot {
  date: number;
  mcap: number;
}

export type SupplySnapshotMap = Map<string, SupplySnapshot[]>;

export interface StabilityInputForDay {
  depegs: Array<{ bps: number; mcapUsd: number; depegAgeDays: number }>;
  totalMcapUsd: number;
  mcap7dChangePct: number;
  depegCount: number;
}

export function buildSupplySnapshotMap(rows: PsiSupplyRow[]): SupplySnapshotMap {
  const supplyByCoin: SupplySnapshotMap = new Map();
  for (const row of rows) {
    const list = supplyByCoin.get(row.stablecoin_id) ?? [];
    list.push({ date: row.snapshot_date, mcap: row.circulating_usd });
    supplyByCoin.set(row.stablecoin_id, list);
  }

  for (const snapshots of supplyByCoin.values()) {
    snapshots.sort((a, b) => a.date - b.date);
  }

  return supplyByCoin;
}

export function findNearestSupplySnapshot(
  snapshots: SupplySnapshot[] | undefined,
  targetDay: number,
): SupplySnapshot | null {
  if (!snapshots || snapshots.length === 0) return null;

  let best = snapshots[0];
  for (const snapshot of snapshots) {
    if (Math.abs(snapshot.date - targetDay) < Math.abs(best.date - targetDay)) {
      best = snapshot;
    }
    if (snapshot.date > targetDay) break;
  }

  if (Math.abs(best.date - targetDay) > MAX_SUPPLY_SNAPSHOT_DISTANCE_SEC) {
    return null;
  }

  return best;
}

function getTotalMcapForDay(supplyByCoin: SupplySnapshotMap, day: number): number {
  let total = 0;
  for (const snapshots of supplyByCoin.values()) {
    const nearest = findNearestSupplySnapshot(snapshots, day);
    if (nearest) total += nearest.mcap;
  }
  return total;
}

export function buildStabilityInputForDay(
  day: number,
  now: number,
  depegEvents: PsiDepegEventRow[],
  supplyByCoin: SupplySnapshotMap,
): StabilityInputForDay {
  const activeDepegs = depegEvents.filter(
    (event) => event.started_at <= day && (event.ended_at === null ? day <= now : event.ended_at > day),
  );

  const grouped = new Map<string, PsiDepegEventRow[]>();
  for (const event of activeDepegs) {
    const list = grouped.get(event.stablecoin_id) ?? [];
    list.push(event);
    grouped.set(event.stablecoin_id, list);
  }

  const depegs: Array<{ bps: number; mcapUsd: number; depegAgeDays: number }> = [];
  for (const [coinId, events] of grouped) {
    let worstBps = 0;
    let earliestStart = Infinity;

    for (const event of events) {
      if (event.peg_reference <= 0) continue;
      if (Math.abs(event.peak_deviation_bps) > Math.abs(worstBps)) {
        worstBps = event.peak_deviation_bps;
      }
      if (event.started_at < earliestStart) {
        earliestStart = event.started_at;
      }
    }

    if (earliestStart === Infinity) continue;
    const snapshot = findNearestSupplySnapshot(supplyByCoin.get(coinId), day);
    depegs.push({
      bps: worstBps,
      mcapUsd: snapshot?.mcap ?? 0,
      depegAgeDays: Math.max(0, (day - earliestStart) / DAY),
    });
  }

  const totalMcapUsd = getTotalMcapForDay(supplyByCoin, day);
  const totalMcap7dAgo = getTotalMcapForDay(supplyByCoin, day - 7 * DAY);
  const mcap7dChangePct =
    totalMcap7dAgo > 0
      ? ((totalMcapUsd - totalMcap7dAgo) / totalMcap7dAgo) * 100
      : 0;

  return {
    depegs,
    totalMcapUsd,
    mcap7dChangePct,
    depegCount: depegs.length,
  };
}
