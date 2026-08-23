import type { DdrV2StoreContracts } from "../depeg-resolver-v2-contracts";

export async function reapRecoveredPreLockIncidents(input: {
  stores: DdrV2StoreContracts;
  db: D1Database;
  nowSec: number;
}): Promise<number> {
  if (!input.stores.closeRecoveredPreLockIncidents) return 0;
  return input.stores.closeRecoveredPreLockIncidents(input.db, { nowSec: input.nowSec });
}
