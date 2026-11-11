import type { YieldType } from "@shared/types/yield-vocabulary";
import type { ResolvedYield, ResolvedYieldEntry } from "./types";
import { YIELD_VARIANT_CHILD_VENUE_PROTOCOLS } from "@shared/lib/yield-source-risk-registry";
import type { YieldDeploymentPlace, YieldSourceRisk } from "@shared/types/yield";
import { ON_CHAIN_RATE_CONFIGS } from "../../lib/yield-config/yield-config-rate-sources";
import { getActiveStablecoinMeta, normalizeYieldPoolChain, isThirdPartyYieldOpportunityType } from "./resolve-pools";

function getResolvedEntryKey(entry: ResolvedYieldEntry): string | null {
  return entry.yield ? `${entry.id}:${entry.yield.sourceKey}` : null;
}

function inferLinkedVariantDeploymentPlace(
  variantKind: string | undefined,
  childYieldType: YieldType | undefined,
): YieldDeploymentPlace | null {
  if (variantKind === "strategy-vault") return "strategy-vault";
  if (variantKind === "savings-passthrough") return "native-wrapper";
  if (variantKind === "risk-absorption" || variantKind === "bond-maturity") return "structured-tranche";
  if (childYieldType === "lp-receipt") return "lp-or-dex";
  if (childYieldType === "lending-vault") return "strategy-vault";
  if (childYieldType === "nav-appreciation" || childYieldType === "rebase") return "native-wrapper";
  if (childYieldType === "governance-set" || childYieldType === "fee-sharing") return "issuer-savings";
  return null;
}

function resolveLinkedVariantChain(
  childId: string,
  source: ResolvedYield,
  contracts: Array<{ chain?: string }> | undefined,
): string | null {
  if (source.sourceRisk?.venueChain) return normalizeYieldPoolChain(source.sourceRisk.venueChain);
  if (source.chain) return normalizeYieldPoolChain(source.chain);
  const onChainConfig = ON_CHAIN_RATE_CONFIGS.find((config) => config.stablecoinId === childId);
  if (onChainConfig) return normalizeYieldPoolChain(onChainConfig.chain);

  const uniqueChains = [...new Set((contracts ?? []).flatMap((contract) => (contract.chain ? [contract.chain] : [])))];
  return uniqueChains.length === 1 ? normalizeYieldPoolChain(uniqueChains[0]!) : null;
}

function buildLinkedVariantSourceRisk(params: {
  childId: string;
  childYieldType: YieldType | undefined;
  variantKind: string | undefined;
  contracts: Array<{ chain?: string }> | undefined;
  source: ResolvedYield;
}): YieldSourceRisk {
  const existing = params.source.sourceRisk ?? {};
  const venueProtocol =
    existing.venueProtocol ??
    params.source.project ??
    YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[params.childId] ??
    null;
  const venueChain = resolveLinkedVariantChain(params.childId, params.source, params.contracts);

  return {
    ...existing,
    deploymentPlace:
      existing.deploymentPlace ?? inferLinkedVariantDeploymentPlace(params.variantKind, params.childYieldType),
    venueProtocol,
    venueChain,
  };
}

function hasParentSourcePool(resolved: ResolvedYieldEntry[], parentId: string, sourcePool: string | null): boolean {
  if (!sourcePool) return false;
  return resolved.some((entry) => entry.id === parentId && entry.yield?.sourcePool === sourcePool);
}

export function appendLinkedVariantParentYieldSources(resolved: ResolvedYieldEntry[]): number {
  const existingKeys = new Set(
    resolved
      .map(getResolvedEntryKey)
      .filter((key): key is string => key != null),
  );
  const existingSourcePools = new Set(
    resolved
      .flatMap((entry) => entry.yield?.sourcePool ? [`${entry.id}:${entry.yield.sourcePool}`] : []),
  );
  const additions: ResolvedYieldEntry[] = [];

  for (const entry of resolved) {
    if (!entry.yield || entry.yield.observationKind === "anchor-only") continue;
    if (entry.yield.dataSource === "defillama-auto") continue;

    const childMeta = getActiveStablecoinMeta(entry.id);
    if (!childMeta?.variantOf) continue;

    const parentMeta = getActiveStablecoinMeta(childMeta.variantOf);
    if (!parentMeta) continue;

    const effectiveYieldType = entry.yield.yieldType ?? childMeta.yieldConfig?.yieldType;
    if (isThirdPartyYieldOpportunityType(effectiveYieldType)) continue;

    const sourcePoolKey = entry.yield.sourcePool ? `${parentMeta.id}:${entry.yield.sourcePool}` : null;
    if (
      sourcePoolKey
      && (existingSourcePools.has(sourcePoolKey) || hasParentSourcePool(additions, parentMeta.id, entry.yield.sourcePool))
    ) {
      continue;
    }

    const sourceKey = `linked-variant:${childMeta.id}:${entry.yield.sourceKey}`;
    const entryKey = `${parentMeta.id}:${sourceKey}`;
    if (existingKeys.has(entryKey)) continue;

    additions.push({
      id: parentMeta.id,
      symbol: parentMeta.symbol,
      yield: {
        ...entry.yield,
        sourceKey,
        yieldSource: entry.yield.yieldSource ?? childMeta.yieldConfig?.yieldSource,
        // Holding the deposit asset does not earn a wrapper's NAV yield. The
        // parent projection therefore represents the action of acquiring the
        // child receipt token, while the original child row remains intrinsic.
        yieldType: "lending-opportunity",
        project:
          entry.yield.sourceRisk?.venueProtocol ??
          entry.yield.project ??
          YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[childMeta.id],
        chain: resolveLinkedVariantChain(childMeta.id, entry.yield, childMeta.contracts),
        sourceRisk: buildLinkedVariantSourceRisk({
          childId: childMeta.id,
          childYieldType: effectiveYieldType,
          variantKind: childMeta.variantKind,
          contracts: childMeta.contracts,
          source: entry.yield,
        }),
      },
    });
    existingKeys.add(entryKey);
    if (sourcePoolKey) {
      existingSourcePools.add(sourcePoolKey);
    }
  }

  resolved.push(...additions);
  return additions.length;
}
