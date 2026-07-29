import type { RedemptionRouteFamily } from "../../types";
import type { RedemptionBackstopConfig } from "./shared";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS, COLLATERAL_REDEEM_BACKSTOP_ENTRIES } from "./collateral-redeem";
import { defineBackstopRegistry, type RedemptionBackstopRegistryEntry } from "./factory";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS, OFFCHAIN_ISSUER_BACKSTOP_ENTRIES } from "./offchain-issuer/index";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS, PSM_AND_BASKET_BACKSTOP_ENTRIES } from "./psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS, QUEUE_REDEEM_BACKSTOP_ENTRIES } from "./queue-redeem";
import {
  STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
  STABLECOIN_REDEEM_BACKSTOP_ENTRIES,
} from "./stablecoin-redeem/configs";

export interface RedemptionBackstopConfigManifestEntry {
  name: string;
  filePath: string;
  configs: Record<string, RedemptionBackstopConfig>;
  /**
   * The registry entries `configs` was built from, carrying the per-id override
   * reasons and source file paths that the record itself cannot express.
   */
  entries: readonly RedemptionBackstopRegistryEntry[];
  allowedRouteFamilies: readonly RedemptionRouteFamily[];
  reviewerLane?: string;
}

export const REDEMPTION_BACKSTOP_CONFIG_MANIFEST = [
  {
    name: "offchain-issuer",
    filePath: "shared/lib/redemption-backstop-configs/offchain-issuer/index.ts",
    configs: OFFCHAIN_ISSUER_BACKSTOP_CONFIGS,
    entries: OFFCHAIN_ISSUER_BACKSTOP_ENTRIES,
    allowedRouteFamilies: ["offchain-issuer"],
    reviewerLane: "issuer/legal redemption rails",
  },
  {
    name: "psm-and-basket",
    filePath: "shared/lib/redemption-backstop-configs/psm-and-basket.ts",
    configs: PSM_AND_BASKET_BACKSTOP_CONFIGS,
    entries: PSM_AND_BASKET_BACKSTOP_ENTRIES,
    allowedRouteFamilies: ["basket-redeem", "psm-swap"],
    reviewerLane: "onchain swap and basket rails",
  },
  {
    name: "collateral-redeem",
    filePath: "shared/lib/redemption-backstop-configs/collateral-redeem.ts",
    configs: COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
    entries: COLLATERAL_REDEEM_BACKSTOP_ENTRIES,
    allowedRouteFamilies: ["collateral-redeem"],
    reviewerLane: "collateral redemption rails",
  },
  {
    name: "queue-redeem",
    filePath: "shared/lib/redemption-backstop-configs/queue-redeem.ts",
    configs: QUEUE_REDEEM_BACKSTOP_CONFIGS,
    entries: QUEUE_REDEEM_BACKSTOP_ENTRIES,
    allowedRouteFamilies: ["queue-redeem"],
    reviewerLane: "queued redemption rails",
  },
  {
    name: "stablecoin-redeem",
    filePath: "shared/lib/redemption-backstop-configs/stablecoin-redeem/configs.ts",
    configs: STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
    entries: STABLECOIN_REDEEM_BACKSTOP_ENTRIES,
    allowedRouteFamilies: ["stablecoin-redeem"],
    reviewerLane: "protocol stablecoin redemption rails",
  },
] as const satisfies readonly RedemptionBackstopConfigManifestEntry[];

export function buildRedemptionBackstopRegistry(
  manifest: readonly RedemptionBackstopConfigManifestEntry[] = REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
): Record<string, RedemptionBackstopConfig> {
  const entries: RedemptionBackstopRegistryEntry[] = [];
  const ownerById = new Map<string, RedemptionBackstopConfigManifestEntry>();

  for (const moduleEntry of manifest) {
    for (const entry of moduleEntry.entries) {
      const owner = ownerById.get(entry.id);
      if (owner && owner !== moduleEntry) {
        throw new Error(
          `Duplicate redemption backstop config id "${entry.id}" appears in both ${owner.name} (${owner.filePath}) and ${moduleEntry.name} (${moduleEntry.filePath}).`,
        );
      }
      ownerById.set(entry.id, moduleEntry);
      entries.push({
        ...entry,
        sourceFilePath: entry.sourceFilePath ?? moduleEntry.filePath,
      });
    }
  }

  return defineBackstopRegistry(entries);
}
