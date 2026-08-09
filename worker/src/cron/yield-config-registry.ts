import type { YieldType } from "@shared/types/core";
import type {
  YieldAdapterLifecycle,
  YieldAdapterLifecycleReason,
  YieldBenchmarkKey,
} from "@shared/types/yield";
import { buildOnChainSourceKey } from "../lib/yield-utils";

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
}

export interface RateDerivedConfig {
  stablecoinId: string;
  spreadBps: number;
  label: string;
  benchmarkCurrency?: YieldBenchmarkKey;
  benchmarkOverrideKey?: YieldBenchmarkKey;
}

export interface YieldRegistryEntry {
  stablecoinId: string;
  variant?: YieldVariant;
  nativePoolId?: string;
  weightedPoolGroupSourceKey?: string;
  onChainRate?: OnChainRateConfig;
  directProtocolApiLabel?: string;
  directProtocolApiSourceKey?: string;
  priceDerivedFallback?: boolean;
  rateDerived?: RateDerivedConfig;
  autoLendingPoolId?: string;
  bypassesAutoLendingSafety?: boolean;
  deterministicQuarantineReason?: string;
  intentionalGapReason?: string;
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
  deterministicQuarantineReason?: string;
}

export function deriveYieldRegistry(args: {
  yieldBearingIds: string[];
  navTokenIds: Set<string>;
  variantMap: Record<string, YieldVariant>;
  poolMap: Record<string, string>;
  weightedPoolGroups: Record<string, { sourceKey: string }>;
  onChainRateConfigs: OnChainRateConfig[];
  directProtocolApiStrategies: Record<string, string>;
  directProtocolApiSourceKeys: Record<string, string>;
  priceDerivedFallbackIds: Set<string>;
  rateDerivedConfigs: RateDerivedConfig[];
  autoLendingPoolMap: Record<string, string>;
  autoLendingSafetyBypassIds: Set<string>;
  quarantinedDeterministicAdapters: Record<string, string>;
  intentionalGapReasons: Record<string, string>;
  /**
   * Typed lifecycle state per stablecoin ID. Unlisted IDs default to
   * `{ lifecycle: "active" }`. Quarantines and intentional gaps carry a
   * structured reason that supersedes the legacy free-form rationale strings in
   * `quarantinedDeterministicAdapters` / `intentionalGapReasons`; those string
   * maps stay so the manifest descriptor `rationale` fields keep their copy.
   */
  adapterLifecycle: Record<string, YieldAdapterLifecycleEntry>;
}): {
  registry: YieldRegistryEntry[];
  variantMap: Record<string, YieldVariant>;
  poolMap: Record<string, string>;
  onChainRateConfigs: OnChainRateConfig[];
  priceDerivedFallbackIds: Set<string>;
  rateDerivedConfigs: RateDerivedConfig[];
  autoLendingPoolMap: Record<string, string>;
  autoLendingSafetyBypassIds: Set<string>;
  manifest: YieldAdapterManifestEntry[];
} {
  const configIds = new Set<string>([
    ...args.yieldBearingIds,
    ...Object.keys(args.variantMap),
    ...Object.keys(args.poolMap),
    ...Object.keys(args.weightedPoolGroups),
    ...args.onChainRateConfigs.map((config) => config.stablecoinId),
    ...Object.keys(args.directProtocolApiStrategies),
    ...Object.keys(args.directProtocolApiSourceKeys),
    ...args.priceDerivedFallbackIds,
    ...args.rateDerivedConfigs.map((config) => config.stablecoinId),
    ...Object.keys(args.autoLendingPoolMap),
    ...args.autoLendingSafetyBypassIds,
    ...Object.keys(args.quarantinedDeterministicAdapters),
    ...Object.keys(args.intentionalGapReasons),
  ]);

  const registry = [...configIds]
    .sort((a, b) => a.localeCompare(b))
    .map((stablecoinId) => ({
      stablecoinId,
      variant: args.variantMap[stablecoinId],
      nativePoolId: args.poolMap[stablecoinId],
      weightedPoolGroupSourceKey: args.weightedPoolGroups[stablecoinId]?.sourceKey,
      onChainRate: args.onChainRateConfigs.find((config) => config.stablecoinId === stablecoinId),
      directProtocolApiLabel: args.directProtocolApiStrategies[stablecoinId],
      directProtocolApiSourceKey: args.directProtocolApiSourceKeys[stablecoinId],
      priceDerivedFallback: args.priceDerivedFallbackIds.has(stablecoinId) || undefined,
      rateDerived: args.rateDerivedConfigs.find((config) => config.stablecoinId === stablecoinId),
      autoLendingPoolId: args.autoLendingPoolMap[stablecoinId],
      bypassesAutoLendingSafety: args.autoLendingSafetyBypassIds.has(stablecoinId) || undefined,
      deterministicQuarantineReason: args.quarantinedDeterministicAdapters[stablecoinId],
      intentionalGapReason: args.intentionalGapReasons[stablecoinId],
    }));

  const registryById = new Map(registry.map((entry) => [entry.stablecoinId, entry] as const));
  const derivedVariantMap = Object.fromEntries(
    registry
      .filter((entry) => entry.variant)
      .map((entry) => [entry.stablecoinId, entry.variant]),
  ) as Record<string, YieldVariant>;
  const derivedPoolMap = Object.fromEntries(
    registry
      .filter((entry) => entry.nativePoolId)
      .map((entry) => [entry.stablecoinId, entry.nativePoolId]),
  ) as Record<string, string>;
  const derivedOnChainRateConfigs = registry.flatMap((entry) => entry.onChainRate ? [entry.onChainRate] : []);
  const derivedPriceFallbackIds = new Set(
    registry
      .filter((entry) => entry.priceDerivedFallback)
      .map((entry) => entry.stablecoinId),
  );
  const derivedRateConfigs = registry.flatMap((entry) => entry.rateDerived ? [entry.rateDerived] : []);
  const derivedAutoLendingPoolMap = Object.fromEntries(
    registry
      .filter((entry) => entry.autoLendingPoolId)
      .map((entry) => [entry.stablecoinId, entry.autoLendingPoolId]),
  ) as Record<string, string>;
  const derivedAutoLendingSafetyBypassIds = new Set(
    registry
      .filter((entry) => entry.bypassesAutoLendingSafety)
      .map((entry) => entry.stablecoinId),
  );

  const manifest = args.yieldBearingIds
    .map((stablecoinId) => {
      const entry = registryById.get(stablecoinId);
      const strategies: YieldStrategyDescriptor[] = [];

      if (entry?.nativePoolId) {
        strategies.push({
          kind: "native-pool",
          label: "Curated DeFiLlama pool UUID",
          sourceKey: entry.nativePoolId,
          priority: 10,
        });
      }
      if (entry?.variant) {
        strategies.push({
          kind: "variant-pool",
          label: entry.variant.variantSymbol,
          sourceKey: null,
          sourceKeyPattern: "defillama:<runtime-pool-uuid>",
          priority: 20,
        });
      }
      if (entry?.weightedPoolGroupSourceKey) {
        strategies.push({
          kind: "weighted-pool",
          label: "TVL-weighted DeFiLlama pool group",
          sourceKey: entry.weightedPoolGroupSourceKey,
          priority: 25,
        });
      }
      if (entry?.onChainRate) {
        strategies.push({
          kind: "deterministic-onchain",
          label: "On-chain exchange-rate reader",
          sourceKey: buildOnChainSourceKey(stablecoinId),
          priority: 30,
        });
      }
      if (entry?.directProtocolApiLabel) {
        strategies.push({
          kind: "protocol-api",
          label: entry.directProtocolApiLabel,
          sourceKey: entry.directProtocolApiSourceKey ?? null,
          priority: 40,
        });
      }
      if (entry?.rateDerived) {
        strategies.push({
          kind: "rate-derived",
          label: "Benchmark-linked rate fallback",
          sourceKey: "rate-derived",
          priority: 50,
        });
      }
      if (args.navTokenIds.has(stablecoinId) || entry?.priceDerivedFallback) {
        strategies.push({
          kind: "price-derived",
          label: "Supply-history NAV appreciation fallback",
          sourceKey: "price-derived",
          priority: 60,
        });
      }
      if (entry?.autoLendingPoolId) {
        strategies.push({
          kind: "auto-discovery-override",
          label: "Explicit lending override pool",
          sourceKey: entry.autoLendingPoolId,
          priority: 70,
        });
      }
      if (entry?.deterministicQuarantineReason) {
        const lifecycleEntry = args.adapterLifecycle[stablecoinId] ?? { lifecycle: "active" };
        strategies.push({
          kind: "quarantined",
          label: "Quarantined deterministic reader",
          sourceKey: null,
          sourceKeyPattern: buildOnChainSourceKey(stablecoinId),
          rationale: entry.deterministicQuarantineReason,
          lifecycle: "quarantined",
          lifecycleReason: lifecycleEntry.lifecycle === "quarantined" ? lifecycleEntry.reason : undefined,
          priority: 80,
        });
      }
      if (entry?.intentionalGapReason) {
        const lifecycleEntry = args.adapterLifecycle[stablecoinId] ?? { lifecycle: "active" };
        strategies.push({
          kind: "intentional-gap",
          label: "Intentional coverage gap",
          sourceKey: null,
          rationale: entry.intentionalGapReason,
          lifecycle: "intentional-gap",
          lifecycleReason: lifecycleEntry.lifecycle === "intentional-gap" ? lifecycleEntry.reason : undefined,
          priority: 90,
        });
      }

      return {
        stablecoinId,
        status: entry?.intentionalGapReason ? "intentional-gap" as const : "covered" as const,
        strategies: strategies.sort((a, b) => a.priority - b.priority),
        variant: entry?.variant,
        nativePoolId: entry?.nativePoolId,
        weightedPoolGroupSourceKey: entry?.weightedPoolGroupSourceKey,
        onChainRate: entry?.onChainRate,
        priceDerivedFallback: (args.navTokenIds.has(stablecoinId) || entry?.priceDerivedFallback) || undefined,
        rateDerived: entry?.rateDerived,
        autoLendingPoolId: entry?.autoLendingPoolId,
        bypassesAutoLendingSafety: entry?.bypassesAutoLendingSafety,
        deterministicQuarantineReason: entry?.deterministicQuarantineReason,
      };
    })
    .sort((a, b) => a.stablecoinId.localeCompare(b.stablecoinId));

  return {
    registry,
    variantMap: derivedVariantMap,
    poolMap: derivedPoolMap,
    onChainRateConfigs: derivedOnChainRateConfigs,
    priceDerivedFallbackIds: derivedPriceFallbackIds,
    rateDerivedConfigs: derivedRateConfigs,
    autoLendingPoolMap: derivedAutoLendingPoolMap,
    autoLendingSafetyBypassIds: derivedAutoLendingSafetyBypassIds,
    manifest,
  };
}
