import { YIELD_BEARING_STABLECOINS } from "@shared/lib/tracked-stablecoin-utils";
import {
  deriveYieldRegistry,
  type OnChainRateConfig,
  type RateDerivedConfig,
  type YieldAdapterManifestEntry,
  type YieldVariant,
} from "./yield-config-registry";
import { EXPLICIT_YIELD_SOURCE_POOL_MAP } from "./yield-config-explicit-pools";
import {
  AUTO_LENDING_POOL_MAP as RAW_AUTO_LENDING_POOL_MAP,
  AUTO_LENDING_SAFETY_BYPASS_IDS as RAW_AUTO_LENDING_SAFETY_BYPASS_IDS,
  AUTO_LENDING_COLLISION_BLOCKLIST,
  isAutoLendingCollisionBlockedForStablecoin,
} from "./yield-config-lending-protocols";
import { YIELD_POOL_MAP as RAW_YIELD_POOL_MAP } from "./yield-config-pools";
import {
  DIRECT_PROTOCOL_API_STRATEGIES as RAW_DIRECT_PROTOCOL_API_STRATEGIES,
  DIRECT_PROTOCOL_API_SOURCE_KEYS as RAW_DIRECT_PROTOCOL_API_SOURCE_KEYS,
  INTENTIONAL_GAP_REASONS as RAW_INTENTIONAL_GAP_REASONS,
  ON_CHAIN_RATE_CONFIGS as RAW_ON_CHAIN_RATE_CONFIGS,
  PRICE_DERIVED_FALLBACK_IDS as RAW_PRICE_DERIVED_FALLBACK_IDS,
  QUARANTINED_DETERMINISTIC_ADAPTERS as RAW_QUARANTINED_DETERMINISTIC_ADAPTERS,
  RATE_DERIVED_CONFIGS as RAW_RATE_DERIVED_CONFIGS,
  YIELD_ADAPTER_LIFECYCLE as RAW_YIELD_ADAPTER_LIFECYCLE,
} from "./yield-config-rate-sources";
import { YIELD_VARIANT_MAP as RAW_YIELD_VARIANT_MAP } from "./yield-config-variants";
import { YIELD_WEIGHTED_POOL_GROUPS } from "./yield-config-weighted-pools";

export type { ExplicitYieldPoolConfig } from "./yield-config-explicit-pools";
export { EXPLICIT_YIELD_SOURCE_POOL_MAP };
export { LENDING_PROTOCOL_ALLOWLIST, LENDING_PROTOCOL_LABELS } from "./yield-config-lending-protocols";
export { YIELD_WEIGHTED_POOL_GROUPS };

const derivedYieldConfig = deriveYieldRegistry({
  yieldBearingIds: YIELD_BEARING_STABLECOINS.map((meta) => meta.id),
  navTokenIds: new Set(
    YIELD_BEARING_STABLECOINS
      .filter((meta) => meta.flags.navToken)
      .map((meta) => meta.id),
  ),
  variantMap: RAW_YIELD_VARIANT_MAP,
  poolMap: RAW_YIELD_POOL_MAP,
  weightedPoolGroups: YIELD_WEIGHTED_POOL_GROUPS,
  onChainRateConfigs: RAW_ON_CHAIN_RATE_CONFIGS,
  directProtocolApiStrategies: RAW_DIRECT_PROTOCOL_API_STRATEGIES,
  directProtocolApiSourceKeys: RAW_DIRECT_PROTOCOL_API_SOURCE_KEYS,
  priceDerivedFallbackIds: RAW_PRICE_DERIVED_FALLBACK_IDS,
  rateDerivedConfigs: RAW_RATE_DERIVED_CONFIGS,
  autoLendingPoolMap: RAW_AUTO_LENDING_POOL_MAP,
  autoLendingSafetyBypassIds: RAW_AUTO_LENDING_SAFETY_BYPASS_IDS,
  quarantinedDeterministicAdapters: RAW_QUARANTINED_DETERMINISTIC_ADAPTERS,
  intentionalGapReasons: RAW_INTENTIONAL_GAP_REASONS,
  adapterLifecycle: RAW_YIELD_ADAPTER_LIFECYCLE,
});

export const YIELD_SOURCE_REGISTRY = derivedYieldConfig.registry;
export const YIELD_VARIANT_MAP: Record<string, YieldVariant> = derivedYieldConfig.variantMap;
export const YIELD_POOL_MAP: Record<string, string> = derivedYieldConfig.poolMap;
export const ON_CHAIN_RATE_CONFIGS: OnChainRateConfig[] = derivedYieldConfig.onChainRateConfigs;
export const PRICE_DERIVED_FALLBACK_IDS = derivedYieldConfig.priceDerivedFallbackIds;
export const RATE_DERIVED_CONFIGS: RateDerivedConfig[] = derivedYieldConfig.rateDerivedConfigs;
export const AUTO_LENDING_POOL_MAP: Record<string, string> = derivedYieldConfig.autoLendingPoolMap;
export const AUTO_LENDING_SAFETY_BYPASS_IDS = derivedYieldConfig.autoLendingSafetyBypassIds;
export { AUTO_LENDING_COLLISION_BLOCKLIST, isAutoLendingCollisionBlockedForStablecoin };
export const YIELD_ADAPTER_MANIFEST: YieldAdapterManifestEntry[] = derivedYieldConfig.manifest;
