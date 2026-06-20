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
      "shared/lib/redemption-backstop-configs/offchain-issuer/shared.ts",
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
    filePath: "shared/lib/redemption-backstop-configs/stablecoin-redeem/index.ts",
    sourceFilePaths: [
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/aa-falconx-mev-capital.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/aid-gaib.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/apxusd-apyx.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/autousd-auto-finance.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/bbqusdc-steakhouse.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/cusdo-openeden.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/dusd-dtrinity.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/eearn-ember.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/frxusd-frax.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/ftusd-flying-tulip.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/fxsave-f-x-protocol.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/gtusdc-gauntlet.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/gtusdcp-gauntlet.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/jupusd-jupiter.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/msusd-main-street.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/msy-main-street.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/ousd-origin-protocol.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/ousg-ondo-finance.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/pusd-polymarket.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/said-gaib.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/sbold-k3-capital.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/scrvusd-curve.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/sdai-sky.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/sdola-inverse-finance.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/sdusd-dtrinity.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/sfrxusd-frax.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/sgho-aave.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/shared.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/srusd-reservoir.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/stcusd-cap.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/steakusdc-steakhouse.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/steakusdt-steakhouse.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/stusds-sky.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/susdc-spark.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/susdd-tron-dao-reserve.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/susd-solayer.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/susds-sky.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/susdt-spark.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/susn-noon.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/syzusd-yuzu.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usd0-usual.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usda-avalon.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usdai-usd-ai.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usdb-blast.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usdcx-movement.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usde-ethena.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usdf-astherus.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usdsc-startale.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usdv-solomon.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usdz-anzen.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usn-noon.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usr-resolv.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usx-dforce.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/usx-solstice.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/u-united-stables.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/weusd-picwe.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/wm-m0.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/wsrusd-reservoir.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/xdai-gnosis.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/ybold-yearn.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/yousd-yield-optimizer.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/yusd-aegis.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/yusd-yieldfi.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/yvusdc-yearn.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/zchf-frankencoin.ts",
      "shared/lib/redemption-backstop-configs/stablecoin-redeem/zys-zephyr-protocol.ts",
    ],
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
