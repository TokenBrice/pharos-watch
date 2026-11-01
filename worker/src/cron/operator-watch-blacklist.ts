import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
import type { OperatorWatchCondition } from "./cron-staleness-watchdog";
import { loadBlacklistConfigStates } from "./blacklist/sync-support";

/**
 * One missed six-hourly run leaves a config behind; two consecutive misses mean
 * its cursor is no longer tracking the chain head. The producer-level clock is
 * the minimum success time, so a single stuck config extends it but does not
 * stale the public endpoint until every config fails.
 */
export const BLACKLIST_CONFIG_STALE_AGE_SEC = CRON_INTERVALS["sync-blacklist"] * 2;

export interface BlacklistConfigWatchResult {
  conditions: OperatorWatchCondition[];
  readFailed: boolean;
}

export async function loadBlacklistConfigWatchConditions(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<BlacklistConfigWatchResult> {
  try {
    const { configStates } = await loadBlacklistConfigStates(db, signal);
    return {
      readFailed: false,
      conditions: configStates.map((state): OperatorWatchCondition => {
        const lastSucceededAt = state.lastSucceededAt;
        const ageSec = lastSucceededAt == null ? null : Math.max(0, nowSec - lastSucceededAt);
        return {
          section: "producer",
          // Bare producer ids are unique; the prefix keeps this cohort distinct
          // from the job-name conditions in the same alert section.
          id: `sync-blacklist:${state.configKey}`,
          label: lastSucceededAt == null
            ? `${state.config.stablecoin} ${state.config.chain.chainName} never succeeded (${state.configKey})`
            : `${state.config.stablecoin} ${state.config.chain.chainName} last succeeded ${Math.floor(ageSec! / 3600)}h ago (${state.configKey})`,
          active: lastSucceededAt == null || ageSec! > BLACKLIST_CONFIG_STALE_AGE_SEC,
        };
      }),
    };
  } catch {
    return { conditions: [], readFailed: true };
  }
}
