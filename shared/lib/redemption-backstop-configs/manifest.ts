import type { RedemptionRouteFamily } from "../../types";
import type { RedemptionBackstopConfig } from "./shared";
import { COLLATERAL_REDEEM_BACKSTOP_CONFIGS } from "./collateral-redeem";
import { OFFCHAIN_ISSUER_BACKSTOP_CONFIGS } from "./offchain-issuer";
import { PSM_AND_BASKET_BACKSTOP_CONFIGS } from "./psm-and-basket";
import { QUEUE_REDEEM_BACKSTOP_CONFIGS } from "./queue-redeem";
import { STABLECOIN_REDEEM_BACKSTOP_CONFIGS } from "./stablecoin-redeem";

export interface RedemptionBackstopConfigManifestEntry {
  name: string;
  filePath: string;
  sourceFilePaths?: readonly string[];
  configs: Record<string, RedemptionBackstopConfig>;
  allowedRouteFamilies: readonly RedemptionRouteFamily[];
  reviewerLane?: string;
}

export const REDEMPTION_BACKSTOP_CONFIG_MANIFEST = [
  {
    name: "offchain-issuer",
    filePath: "shared/lib/redemption-backstop-configs/offchain-issuer/index.ts",
    sourceFilePaths: [
      "shared/lib/redemption-backstop-configs/offchain-issuer/base-batches.ts",
      "shared/lib/redemption-backstop-configs/offchain-issuer/commodity.ts",
      "shared/lib/redemption-backstop-configs/offchain-issuer/coverage-and-stablecoin-audit.ts",
      "shared/lib/redemption-backstop-configs/offchain-issuer/major-issuers.ts",
      "shared/lib/redemption-backstop-configs/offchain-issuer/non-usd-and-tokenized.ts",
      "shared/lib/redemption-backstop-configs/offchain-issuer/remediation-and-late-audit.ts",
    ],
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
    filePath: "shared/lib/redemption-backstop-configs/stablecoin-redeem.ts",
    configs: STABLECOIN_REDEEM_BACKSTOP_CONFIGS,
    allowedRouteFamilies: ["stablecoin-redeem"],
    reviewerLane: "protocol stablecoin redemption rails",
  },
] as const satisfies readonly RedemptionBackstopConfigManifestEntry[];

export function buildRedemptionBackstopRegistry(
  manifest: readonly RedemptionBackstopConfigManifestEntry[] = REDEMPTION_BACKSTOP_CONFIG_MANIFEST,
): Record<string, RedemptionBackstopConfig> {
  return Object.assign({}, ...manifest.map((entry) => entry.configs));
}
