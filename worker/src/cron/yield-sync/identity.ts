import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { normalizeChainId } from "@shared/types/chain-identity";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import { normalizeDexSymbol } from "../../lib/dex-cron-constants";
import { buildChainAddressKey } from "../dex-liquidity/token-resolution";
import type { YieldVariant } from "../../lib/yield-config/yield-config-registry";

export interface YieldIdentityLookups {
  symbolToIds: Map<string, string[]>;
  symbolToChainScopedIds: Map<string, Map<string, string[]>>;
  chainAddressToId: Map<string, string>;
}

export interface YieldCandidateIdentityInput {
  symbol?: string | null;
  chain?: string | null;
  address?: string | null;
}

export interface YieldIdentityResolution {
  status: "matched" | "ambiguous" | "unresolved";
  stablecoinId?: string;
  matchType?: "chain-address" | "unique-chain-symbol" | "unique-symbol";
}

export function getTrackedContracts(meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">) {
  const result = [];
  const seen = new Set<string>();

  for (const contract of [...(meta.contracts ?? []), ...(meta.tradedContracts ?? [])]) {
    const key = buildChainAddressKey(contract.chain, contract.address);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(contract);
  }

  return result;
}

function normalizeYieldSymbol(symbol: string | null | undefined): string {
  return normalizeDexSymbol(symbol ?? "");
}

export function buildYieldIdentityLookups(
  stablecoins: readonly StablecoinMeta[] = ACTIVE_STABLECOINS,
  options: { omitEmptyAddresses?: boolean } = {},
): YieldIdentityLookups {
  const symbolToIds = new Map<string, string[]>();
  const symbolToChainScopedIds = new Map<string, Map<string, string[]>>();
  const chainAddressToId = new Map<string, string>();

  for (const meta of stablecoins) {
    const symbolKey = normalizeYieldSymbol(meta.symbol);
    if (symbolKey) {
      const ids = symbolToIds.get(symbolKey) ?? [];
      if (!ids.includes(meta.id)) {
        ids.push(meta.id);
      }
      symbolToIds.set(symbolKey, ids);
    }

    for (const contract of getTrackedContracts(meta)) {
      const chainId = normalizeChainId(contract.chain);
      if (!chainId || (options.omitEmptyAddresses && !contract.address?.trim())) continue;
      const scopedIdsByChain = symbolToChainScopedIds.get(symbolKey) ?? new Map<string, string[]>();
      const scopedIds = scopedIdsByChain.get(chainId) ?? [];
      if (!scopedIds.includes(meta.id)) {
        scopedIds.push(meta.id);
      }
      scopedIdsByChain.set(chainId, scopedIds);
      symbolToChainScopedIds.set(symbolKey, scopedIdsByChain);

      chainAddressToId.set(buildChainAddressKey(chainId, contract.address), meta.id);
    }
  }

  return {
    symbolToIds,
    symbolToChainScopedIds,
    chainAddressToId,
  };
}

export function resolveYieldCandidateStablecoinId(
  candidate: YieldCandidateIdentityInput,
  lookups: YieldIdentityLookups,
): YieldIdentityResolution {
  const normalizedChain = candidate.chain ? normalizeChainId(candidate.chain) : null;
  const candidateAddress = candidate.address?.trim() ?? "";
  if (normalizedChain && candidateAddress) {
    const byChainAddress = lookups.chainAddressToId.get(buildChainAddressKey(normalizedChain, candidateAddress));
    if (byChainAddress) {
      return {
        status: "matched",
        stablecoinId: byChainAddress,
        matchType: "chain-address",
      };
    }
  }
  // Address evidence is authoritative: never replace a failed identity lookup
  // with a ticker match, even when the ticker is unique.
  if (candidateAddress) return { status: "unresolved" };

  const symbolKey = normalizeYieldSymbol(candidate.symbol);
  if (!symbolKey) {
    return { status: "unresolved" };
  }

  if (normalizedChain) {
    const scopedIds = lookups.symbolToChainScopedIds.get(symbolKey)?.get(normalizedChain) ?? [];
    if (scopedIds.length === 1) {
      return {
        status: "matched",
        stablecoinId: scopedIds[0],
        matchType: "unique-chain-symbol",
      };
    }
    if (scopedIds.length > 1) {
      return { status: "ambiguous" };
    }
  }

  const symbolIds = lookups.symbolToIds.get(symbolKey) ?? [];
  if (symbolIds.length === 1) {
    return {
      status: "matched",
      stablecoinId: symbolIds[0],
      matchType: "unique-symbol",
    };
  }
  if (symbolIds.length > 1) {
    return { status: "ambiguous" };
  }

  return { status: "unresolved" };
}

export function canUseSymbolOnlyYieldMatch(
  meta: Pick<StablecoinMeta, "id" | "symbol" | "contracts" | "tradedContracts">,
  lookups: YieldIdentityLookups,
  chain: string | null | undefined,
): boolean {
  const symbolKey = normalizeYieldSymbol(meta.symbol);
  if (!symbolKey) return false;

  if (chain) {
    const chainId = normalizeChainId(chain);
    if (!chainId) return false;
    const scopedIds = lookups.symbolToChainScopedIds.get(symbolKey)?.get(chainId) ?? [];
    return scopedIds.length === 1 && scopedIds[0] === meta.id;
  }

  const symbolIds = lookups.symbolToIds.get(symbolKey) ?? [];
  return symbolIds.length === 1 && symbolIds[0] === meta.id;
}

export interface TrackedYieldAsset {
  stablecoinId: string;
  symbol: string;
}

export function buildTrackedYieldAssetIndex(
  stablecoins: readonly StablecoinMeta[],
  variants: Readonly<Record<string, YieldVariant>> = {},
): Map<string, TrackedYieldAsset> {
  const lookups = buildYieldIdentityLookups(stablecoins, { omitEmptyAddresses: true });
  const metaById = new Map(stablecoins.map((meta) => [meta.id, meta]));
  const byChainAddress = new Map<string, TrackedYieldAsset>();
  for (const [key, stablecoinId] of lookups.chainAddressToId) {
    const meta = metaById.get(stablecoinId)!;
    byChainAddress.set(key, { stablecoinId: meta.id, symbol: meta.symbol });
  }
  for (const [stablecoinId, variant] of Object.entries(variants)) {
    if (!variant.variantAddress || !variant.variantChain) continue;
    const chain = normalizeChainId(variant.variantChain);
    const address = variant.variantAddress.trim();
    const meta = metaById.get(stablecoinId);
    if (!chain || !address || !meta) continue;
    byChainAddress.set(buildChainAddressKey(chain, address), {
      stablecoinId: meta.id,
      symbol: meta.symbol,
    });
  }
  return byChainAddress;
}
