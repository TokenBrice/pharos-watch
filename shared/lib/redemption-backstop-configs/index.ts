import type { RedemptionBackstopConfig, ReviewedRedemptionTerms } from "./shared";
import { buildRedemptionBackstopRegistry } from "./manifest";
import { PAXG_REVIEWED_REDEMPTION_TERMS, XAUT_REVIEWED_REDEMPTION_TERMS } from "./offchain-issuer/commodity";
import { USDT_REVIEWED_REDEMPTION_TERMS } from "./offchain-issuer/coverage-and-stablecoin-audit";
import { USDE_REVIEWED_REDEMPTION_TERMS } from "./stablecoin-redeem/configs";

export { REDEMPTION_BACKSTOP_CONFIG_MANIFEST } from "./manifest";
export type { RedemptionBackstopConfigManifestEntry } from "./manifest";

export const REDEMPTION_BACKSTOP_CONFIGS: Record<string, RedemptionBackstopConfig> = buildRedemptionBackstopRegistry();

export const COMPACT_REDEMPTION_FEE_TERMS: Readonly<Record<string, ReviewedRedemptionTerms["compactFeeBasis"]>> = {
  "usdt-tether": USDT_REVIEWED_REDEMPTION_TERMS.compactFeeBasis,
  "paxg-paxos": PAXG_REVIEWED_REDEMPTION_TERMS.compactFeeBasis,
  "xaut-tether": XAUT_REVIEWED_REDEMPTION_TERMS.compactFeeBasis,
  "usde-ethena": USDE_REVIEWED_REDEMPTION_TERMS.compactFeeBasis,
};
