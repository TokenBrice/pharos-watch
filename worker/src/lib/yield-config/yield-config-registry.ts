import type { YieldType } from "@shared/types/core";
import type {
  YieldAdapterLifecycle,
  YieldAdapterLifecycleReason,
  YieldBenchmarkKey,
} from "@shared/types/yield";
import { buildOnChainSourceKey } from "../yield-utils";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";

// Reviewed variable-NAV products whose holder return is intentionally USD-based.
const USD_RETURN_VARIABLE_NAV_IDS: Readonly<Record<string, true>> = {
  "fpi-frax": true,
  "isc-international-stable-currency": true,
};

export function isPriceDerivedYieldEligible(stablecoinId: string, intentionalGapReason?: string): boolean {
  const meta = TRACKED_META_BY_ID.get(stablecoinId);
  const yieldType = meta?.yieldConfig?.yieldType;
  const referenceCurrency = meta?.pegReferenceId
    ? TRACKED_META_BY_ID.get(meta.pegReferenceId)?.flags.pegCurrency
    : meta?.flags.pegCurrency;
  return (yieldType === "nav-appreciation" || yieldType === "lending-vault")
    && (referenceCurrency === "USD"
      || (referenceCurrency === "VAR" && USD_RETURN_VARIABLE_NAV_IDS[stablecoinId] === true))
    && !intentionalGapReason;
}

export type { YieldAdapterLifecycle, YieldAdapterLifecycleReason };

export interface YieldAdapterLifecycleEntry {
  lifecycle: YieldAdapterLifecycle;
  reason?: YieldAdapterLifecycleReason;
}

export interface YieldVariant {
  variantSymbol: string;
  variantAddress?: string;
  variantChain?: string;
  variantProject?: string;
  yieldSource?: string;
  yieldType?: YieldType;
}

export interface OnChainRateConfig {
  stablecoinId: string;
  chain: string;
  contract: string;
  selector: string;
  decimals: number;
  inputAmount: string;
  /**
   * Optional measured venue-TVL read for ERC-4626 rate contracts when a
   * pinned DeFiLlama pool join is unavailable. USD-pegged underlyings only.
   * Fail open to null on any read error.
   */
  tvlRead?: {
    kind: "erc4626-total-assets";
    decimals: number;
  };
}

export interface RateDerivedConfig {
  stablecoinId: string;
  spreadBps: number;
  label: string;
  benchmarkCurrency?: YieldBenchmarkKey;
  benchmarkOverrideKey?: YieldBenchmarkKey;
}


export type YieldStrategyKind =
  | "native-pool"
  | "variant-pool"
  | "weighted-pool"
  | "deterministic-onchain"
  | "protocol-api"
  | "price-derived"
  | "rate-derived"
  | "auto-discovery-override"
  | "quarantined"
  | "intentional-gap";

export interface YieldStrategyDescriptor {
  kind: YieldStrategyKind;
  label: string;
  sourceKey?: string | null;
  sourceKeyPattern?: string | null;
  rationale?: string;
  lifecycle?: YieldAdapterLifecycle;
  lifecycleReason?: YieldAdapterLifecycleReason;
  priority: number;
}

export interface YieldAdapterManifestEntry {
  stablecoinId: string;
  status: "covered" | "intentional-gap";
  strategies: YieldStrategyDescriptor[];
  variant?: YieldVariant;
  nativePoolId?: string;
  weightedPoolGroupSourceKey?: string;
  onChainRate?: OnChainRateConfig;
  priceDerivedFallback?: boolean;
  rateDerived?: RateDerivedConfig;
  autoLendingPoolId?: string;
  bypassesAutoLendingSafety?: boolean;
}

export function buildYieldAdapterManifest(args: {
  yieldBearingIds: string[];
  navTokenIds: Set<string>;
  variantMap: Record<string, YieldVariant>;
  poolMap: Record<string, string>;
  weightedPoolGroups: Record<string, { sourceKey: string }>;
  onChainRateConfigs: OnChainRateConfig[];
  directProtocolApiStrategies: Record<string, { label: string; sourceKey: string }>;
  priceDerivedFallbackIds: Set<string>;
  rateDerivedConfigs: RateDerivedConfig[];
  autoLendingPoolMap: Record<string, string>;
  autoLendingSafetyBypassIds: Set<string>;
  intentionalGapReasons: Record<string, string>;
  /**
   * Typed lifecycle state per stablecoin ID. Unlisted IDs default to
   * `{ lifecycle: "active" }`. Quarantines and intentional gaps carry a
   * structured reason for intentional gaps; the string map retains manifest copy.
   */
  adapterLifecycle: Record<string, YieldAdapterLifecycleEntry>;
}): YieldAdapterManifestEntry[] {
  return args.yieldBearingIds
    .map((stablecoinId) => {
      const variant = args.variantMap[stablecoinId];
      const nativePoolId = args.poolMap[stablecoinId];
      const weightedPoolGroupSourceKey = args.weightedPoolGroups[stablecoinId]?.sourceKey;
      const onChainRate = args.onChainRateConfigs.find((config) => config.stablecoinId === stablecoinId);
      const directProtocolApi = args.directProtocolApiStrategies[stablecoinId];
      const rateDerived = args.rateDerivedConfigs.find((config) => config.stablecoinId === stablecoinId);
      const autoLendingPoolId = args.autoLendingPoolMap[stablecoinId];
      const intentionalGapReason = args.intentionalGapReasons[stablecoinId];
      const strategies: YieldStrategyDescriptor[] = [];
      const priceDerivedEligible = (args.navTokenIds.has(stablecoinId) || args.priceDerivedFallbackIds.has(stablecoinId))
        && isPriceDerivedYieldEligible(stablecoinId, intentionalGapReason);

      if (nativePoolId) {
        strategies.push({
          kind: "native-pool",
          label: "Curated DeFiLlama pool UUID",
          sourceKey: nativePoolId,
          priority: 10,
        });
      }
      if (variant) {
        strategies.push({
          kind: "variant-pool",
          label: variant.variantSymbol,
          sourceKey: null,
          sourceKeyPattern: "defillama:<runtime-pool-uuid>",
          priority: 20,
        });
      }
      if (weightedPoolGroupSourceKey) {
        strategies.push({
          kind: "weighted-pool",
          label: "TVL-weighted DeFiLlama pool group",
          sourceKey: weightedPoolGroupSourceKey,
          priority: 25,
        });
      }
      if (onChainRate) {
        strategies.push({
          kind: "deterministic-onchain",
          label: "On-chain exchange-rate reader",
          sourceKey: buildOnChainSourceKey(stablecoinId),
          priority: 30,
        });
      }
      if (directProtocolApi) {
        strategies.push({
          kind: "protocol-api",
          label: directProtocolApi.label,
          sourceKey: directProtocolApi.sourceKey,
          priority: 40,
        });
      }
      if (rateDerived) {
        strategies.push({
          kind: "rate-derived",
          label: "Benchmark-linked rate fallback",
          sourceKey: "rate-derived",
          priority: 50,
        });
      }
      if (priceDerivedEligible) {
        strategies.push({
          kind: "price-derived",
          label: "USD price-appreciation fallback (NAV or vault receipt)",
          sourceKey: "price-derived",
          priority: 60,
        });
      }
      if (autoLendingPoolId) {
        strategies.push({
          kind: "auto-discovery-override",
          label: "Explicit lending override pool",
          sourceKey: autoLendingPoolId,
          priority: 70,
        });
      }
      if (intentionalGapReason) {
        const lifecycleEntry = args.adapterLifecycle[stablecoinId] ?? { lifecycle: "active" };
        strategies.push({
          kind: "intentional-gap",
          label: "Intentional coverage gap",
          sourceKey: null,
          rationale: intentionalGapReason,
          lifecycle: "intentional-gap",
          lifecycleReason: lifecycleEntry.lifecycle === "intentional-gap" ? lifecycleEntry.reason : undefined,
          priority: 90,
        });
      }

      return {
        stablecoinId,
        status: intentionalGapReason ? "intentional-gap" as const : "covered" as const,
        strategies: strategies.sort((a, b) => a.priority - b.priority),
        variant,
        nativePoolId,
        weightedPoolGroupSourceKey,
        onChainRate,
        priceDerivedFallback: priceDerivedEligible || undefined,
        rateDerived,
        autoLendingPoolId,
        bypassesAutoLendingSafety: args.autoLendingSafetyBypassIds.has(stablecoinId) || undefined,
      };
    })
    .sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));
}
