import type { YieldType } from "@shared/types/yield-vocabulary";
import type { ResolvedYield, ResolvedYieldEntry } from "./types";
import { YIELD_VARIANT_CHILD_VENUE_PROTOCOLS } from "@shared/lib/yield-source-risk-registry";
import { MORPHO_NET_YIELD_SOURCES } from "@shared/lib/yield-source-cadence";
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

const MORPHO_VAULT_IDS = new Set<string>(Object.values(MORPHO_NET_YIELD_SOURCES).map(({ stablecoinId }) => stablecoinId));

export function getMorphoVaultParentId(id: string): string | undefined {
  return MORPHO_VAULT_IDS.has(id) ? getActiveStablecoinMeta(id)?.variantOf : undefined;
}

export function buildLinkedVariantParentYieldSource(
  { id, yield: source }: ResolvedYieldEntry,
): (ResolvedYieldEntry & { yield: ResolvedYield }) | null {
  if (!source || source.observationKind === "anchor-only" || source.dataSource === "defillama-auto") return null;
  const childMeta = getActiveStablecoinMeta(id);
  const parentMeta = childMeta?.variantOf ? getActiveStablecoinMeta(childMeta.variantOf) : undefined;
  if (!childMeta || !parentMeta) return null;

  const effectiveYieldType = source.yieldType ?? childMeta.yieldConfig?.yieldType;
  if (isThirdPartyYieldOpportunityType(effectiveYieldType)) return null;

  return {
    id: parentMeta.id,
    symbol: parentMeta.symbol,
    yield: {
      ...source,
      sourceKey: `linked-variant:${id}:${source.sourceKey}`,
      yieldSource: source.yieldSource ?? childMeta.yieldConfig?.yieldSource,
      // Acquiring the receipt token is an external opportunity for the parent.
      yieldType: "lending-opportunity",
      project: source.sourceRisk?.venueProtocol ?? source.project ?? YIELD_VARIANT_CHILD_VENUE_PROTOCOLS[id],
      chain: resolveLinkedVariantChain(id, source, childMeta.contracts),
      sourceRisk: buildLinkedVariantSourceRisk({
        childId: id,
        childYieldType: effectiveYieldType,
        variantKind: childMeta.variantKind,
        contracts: childMeta.contracts,
        source,
      }),
    },
  };
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
    // Configured Morpho vaults project after their own arbitration.
    if (MORPHO_VAULT_IDS.has(entry.id)) continue;
    const projection = buildLinkedVariantParentYieldSource(entry);
    if (!projection) continue;

    const { id, yield: { sourceKey, sourcePool } } = projection;
    const poolKey = sourcePool ? `${id}:${sourcePool}` : null;
    const entryKey = `${id}:${sourceKey}`;
    if (existingKeys.has(entryKey) || (poolKey && existingSourcePools.has(poolKey))) continue;

    additions.push(projection);
    existingKeys.add(entryKey);
    if (poolKey) existingSourcePools.add(poolKey);
  }

  resolved.push(...additions);
  return additions.length;
}
