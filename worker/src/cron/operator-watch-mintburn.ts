import { getCache } from "../lib/db-cache";
import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../lib/mint-burn-pipeline/sync-state";
import type { OperatorWatchCondition } from "./cron-staleness-watchdog";
import { MINT_BURN_EXTENDED_STUCK_STREAK } from "./mint-burn/run-state";

export const MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY =
  "mint-burn:attempt-state:sync-mint-burn-extended";

interface MintBurnAttemptStateEntry {
  lastDisposition?: unknown;
  consecutiveIncomplete?: unknown;
}

interface MintBurnAttemptState {
  entries?: unknown;
}

export interface MintBurnConfigWatchResult {
  conditions: OperatorWatchCondition[];
  readFailed: boolean;
}

function configLabels(): Map<string, string> {
  return new Map(MINT_BURN_CONFIGS.map((config) =>
    [mintBurnConfigKey(config), `${config.symbol} ${config.chain.chainName}`]));
}

export async function loadMintBurnStuckConfigWatchConditions(
  db: D1Database,
  signal?: AbortSignal,
): Promise<MintBurnConfigWatchResult> {
  try {
    const cached = await getCache(db, MINT_BURN_EXTENDED_ATTEMPT_STATE_KEY, signal);
    if (!cached) return { conditions: [], readFailed: true };
    const parsed = JSON.parse(cached.value) as MintBurnAttemptState;
    if (!parsed || typeof parsed !== "object" || !parsed.entries || typeof parsed.entries !== "object") {
      return { conditions: [], readFailed: true };
    }
    const labels = configLabels();
    const conditions: OperatorWatchCondition[] = [];
    for (const [configKey, rawEntry] of Object.entries(parsed.entries as Record<string, MintBurnAttemptStateEntry>)) {
      const streak = rawEntry?.consecutiveIncomplete;
      if (typeof streak !== "number" || !Number.isSafeInteger(streak)
        || streak < MINT_BURN_EXTENDED_STUCK_STREAK) continue;
      conditions.push({
        // Only stuck configs have a condition, so this cohort needs its own
        // section: an absent key is reported as recovered, not silently dropped.
        section: "mint-burn-config",
        id: configKey,
        label: `${labels.get(configKey) ?? "unknown mint/burn config"} (${configKey}, ${streak} incomplete attempts)`,
        active: true,
      });
    }
    return { conditions, readFailed: false };
  } catch {
    return { conditions: [], readFailed: true };
  }
}
