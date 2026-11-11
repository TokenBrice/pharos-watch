import { MINT_BURN_CONFIGS } from "../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../lib/mint-burn-contract-identity";
import type { OperatorWatchCondition } from "./operator-watch-types";
import { loadMintBurnStuckConfigs } from "./mint-burn/run-state";

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
    const result = await loadMintBurnStuckConfigs(db, signal);
    if (result.readFailed) return { conditions: [], readFailed: true };
    const labels = configLabels();
    const conditions: OperatorWatchCondition[] = [];
    for (const { configKey, streak } of result.configs) {
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
