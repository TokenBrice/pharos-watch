import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import { buildYieldAdapterManifest } from "./yield-config-registry";
import {
  AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS,
} from "./yield-config-lending-protocols";
import { YIELD_POOL_MAP } from "./yield-config-pools";
import {
  DIRECT_PROTOCOL_API_STRATEGIES,
  INTENTIONAL_GAP_REASONS,
  ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS,
  RATE_DERIVED_CONFIGS,
  YIELD_ADAPTER_LIFECYCLE,
} from "./yield-config-rate-sources";
import { YIELD_VARIANT_MAP } from "./yield-config-variants";
import { YIELD_WEIGHTED_POOL_GROUPS } from "./yield-config-weighted-pools";

export const YIELD_ADAPTER_MANIFEST = buildYieldAdapterManifest({
  yieldBearingIds: YIELD_BEARING_STABLECOINS.map((meta) => meta.id),
  navTokenIds: new Set(
    YIELD_BEARING_STABLECOINS
      .filter((meta) => meta.flags.navToken)
      .map((meta) => meta.id),
  ),
  variantMap: YIELD_VARIANT_MAP,
  poolMap: YIELD_POOL_MAP,
  weightedPoolGroups: YIELD_WEIGHTED_POOL_GROUPS,
  onChainRateConfigs: ON_CHAIN_RATE_CONFIGS,
  directProtocolApiStrategies: DIRECT_PROTOCOL_API_STRATEGIES,
  priceDerivedFallbackIds: PRICE_DERIVED_FALLBACK_IDS,
  rateDerivedConfigs: RATE_DERIVED_CONFIGS,
  autoLendingPoolMap: AUTO_LENDING_POOL_MAP,
  autoLendingSafetyBypassIds: AUTO_LENDING_SAFETY_BYPASS_IDS,
  intentionalGapReasons: INTENTIONAL_GAP_REASONS,
  adapterLifecycle: YIELD_ADAPTER_LIFECYCLE,
});
