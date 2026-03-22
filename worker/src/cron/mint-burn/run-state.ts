import { normalizeStringSet } from "../../lib/normalizers";

export interface MintBurnRunStateRow {
  nextConfigIndex: number;
  degradedStreak: number;
}

export function normalizeDisabledConfigIdSet(values?: Iterable<string>): Set<string> {
  return normalizeStringSet(values, (value) => value.toLowerCase());
}

export function normalizeDisabledSymbolSet(values?: Iterable<string>): Set<string> {
  return normalizeStringSet(values, (value) => value.toUpperCase());
}

export function rotateArray<T>(values: T[], start: number): T[] {
  if (values.length === 0) return [];
  const idx = ((start % values.length) + values.length) % values.length;
  return [...values.slice(idx), ...values.slice(0, idx)];
}

export async function getMintBurnRunState(
  db: D1Database,
  jobName: string,
): Promise<{ state: MintBurnRunStateRow; persistenceFailed: boolean }> {
  try {
    const row = await db
      .prepare("SELECT next_config_index, degraded_streak FROM mint_burn_run_state WHERE job = ?")
      .bind(jobName)
      .first<{ next_config_index: number; degraded_streak: number }>();

    return {
      state: {
        nextConfigIndex: row?.next_config_index ?? 0,
        degradedStreak: row?.degraded_streak ?? 0,
      },
      persistenceFailed: false,
    };
  } catch (error) {
    console.warn("[sync-mint-burn] Failed to load run-state; using defaults:", error);
    return {
      state: { nextConfigIndex: 0, degradedStreak: 0 },
      persistenceFailed: true,
    };
  }
}

export async function setMintBurnRunState(
  db: D1Database,
  jobName: string,
  nextConfigIndex: number,
  degradedStreak: number,
): Promise<boolean> {
  try {
    const now = Math.floor(Date.now() / 1000);
    await db
      .prepare(
        `INSERT INTO mint_burn_run_state (job, next_config_index, degraded_streak, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job) DO UPDATE SET
           next_config_index = excluded.next_config_index,
           degraded_streak = excluded.degraded_streak,
           updated_at = excluded.updated_at`,
      )
      .bind(jobName, nextConfigIndex, degradedStreak, now)
      .run();
    return true;
  } catch (error) {
    console.warn("[sync-mint-burn] Failed to persist run-state:", error);
    return false;
  }
}
