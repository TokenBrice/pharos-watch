import type { RedemptionBackstopConfig } from "./shared";
import { buildRedemptionBackstopRegistry } from "./manifest";

export { REDEMPTION_BACKSTOP_CONFIG_MANIFEST, buildRedemptionBackstopRegistry } from "./manifest";
export type { RedemptionBackstopConfigManifestEntry } from "./manifest";

export const REDEMPTION_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = buildRedemptionBackstopRegistry();
