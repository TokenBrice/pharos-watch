import { TRACKED_META_BY_ID } from "./stablecoins";
import { REDEMPTION_BACKSTOP_CONFIGS } from "./redemption-backstop-configs";
import type { RedemptionBackstopConfig } from "./redemption-backstop-configs/shared";

export { REDEMPTION_BACKSTOP_CONFIGS };
export type {
  RedemptionBackstopConfig,
  RedemptionCapacityModel,
  RedemptionCostModel,
} from "./redemption-backstop-configs/shared";

for (const stablecoinId of Object.keys(REDEMPTION_BACKSTOP_CONFIGS)) {
  if (!TRACKED_META_BY_ID.has(stablecoinId)) {
    throw new Error(`Unknown redemption backstop config id "${stablecoinId}"`);
  }
}

export function getRedemptionBackstopConfig(stablecoinId: string): RedemptionBackstopConfig | null {
  return REDEMPTION_BACKSTOP_CONFIGS[stablecoinId] ?? null;
}

export function getConfiguredRedemptionBackstopIds(): string[] {
  return Object.keys(REDEMPTION_BACKSTOP_CONFIGS);
}
