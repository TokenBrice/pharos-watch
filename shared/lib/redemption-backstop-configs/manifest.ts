import type { RedemptionRouteFamily } from "../../types";
import type { RedemptionBackstopConfig } from "./shared";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "./collateral-redeem";
import {
  defineBackstopRegistry,
  getBackstopRegistryOverrideReasons,
  getBackstopRegistrySourceFilePaths,
  type RedemptionBackstopRegistryEntry,
} from "./factory";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "./offchain-issuer/index";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS } from "./psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "./queue-redeem";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "./stablecoin-redeem/index";

export interface RedemptionBackstopConfigManifestEntry {
  name: string;
  filePath: string;
  configs: Record<string, RedemptionBackstopConfig>;
  allowedRouteFamilies: readonly RedemptionRouteFamily[];
  reviewerLane?: string;
}

export const REDEMPTION_BACKSTOP_CONFIG_MANIFEST = [
  {
    name: "offchain-issuer",
    filePath: "shared/lib/redemption-backstop-configs/offchain-issuer/index.ts",
    configs: OFFCHAIN_ISSUER_BACKSTOP_CONFIGS,
    allowedRouteFamilies: ["offchain-issuer"],
    reviewerLane: "issuer/legal redemption rails",
  },
  {
    name: "psm-and-basket",
    filePath: "shared/lib/redemption-backstop-configs/psm-and-basket.ts",
    configs: PSM_AND_BASKET_BACKSTOP_CONFIGS,
    allowedRouteFamilies: ["basket-redeem", "psm-swap"],
    reviewerLane: "onchain swap and basket rails",
  },
  {
    name: "collateral-redeem",
    filePath: "shared/lib/redemption-backstop-configs/collateral-redeem.ts",
    configs: COLLATERAL_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: ["collateral-redeem"],
    reviewerLane: "collateral redemption rails",
  },
  {
    name: "queue-redeem",
    filePath: "shared/lib/redemption-backstop-configs/queue-redeem.ts",
    configs: QUEUE_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: ["queue-redeem"],
    reviewerLane: "queued redemption rails",
  },
  {
    name: "stablecoin-redeem",
    filePath: "shared/lib/redemption-backstop-configs/stablecoin-redeem/index.ts",
    configs: STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: ["stablecoin-redeem"],
    reviewerLane: "protocol stablecoin redemption rails",
  },
] as const satisfies readonly RedemptionBackstopConfigManifestEntry[];

export function buildRedemptionBackstopRegistry(
  manifest: readonly RedemptionBackstopConfigManifestEntry[] = REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
): Record<string, RedemptionBackstopConfig> {
  const entries: RedemptionBackstopRegistryEntry[] = [];
  const seenById = new Map<string, Pick<RedemptionBackstopConfigManifestEntry, "name" | "filePath">>();

  for (const entry of manifest) {
    const overrideReasons = getBackstopRegistryOverrideReasons(entry.configs);
    const sourceFilePaths = getBackstopRegistrySourceFilePaths(entry.configs);
    for (const [id, config] of Object.entries(entry.configs)) {
      const previous = seenById.get(id);
      if (previous) {
        throw new Error(
          `Duplicate redemption backstop config id "${id}" appears in both ${previous.name} (${previous.filePath}) and ${entry.name} (${entry.filePath}).`,
        );
      }
      seenById.set(id, entry);
      entries.push({
        id,
        config,
        ...(overrideReasons.has(id) ? { overrideReason: overrideReasons.get(id) } : {}),
        sourceFilePath: sourceFilePaths.get(id) ?? entry.filePath,
      });
    }
  }

  return defineBackstopRegistry(entries);
}
