import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { CHAIN_META, resolveChainId } from "@shared/lib/chains";
import type { StablecoinMeta } from "@shared/types/core";
import { normalizeDexSymbol } from "../../lib/dex-cron-constants";
import { buildChainAddressKey, normalizeTokenAddress } from "../dex-liquidity/token-resolution";

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

function getTrackedContracts(meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">) {
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
      const chainId = resolveChainId(contract.chain) ?? contract.chain.toLowerCase();
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
  const normalizedChain = candidate.chain ? (resolveChainId(candidate.chain) ?? candidate.chain.toLowerCase()) : null;
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
    const chainId = resolveChainId(chain) ?? chain.toLowerCase();
    const scopedIds = lookups.symbolToChainScopedIds.get(symbolKey)?.get(chainId) ?? [];
    return scopedIds.length === 1 && scopedIds[0] === meta.id;
  }

  const symbolIds = lookups.symbolToIds.get(symbolKey) ?? [];
  return symbolIds.length === 1 && symbolIds[0] === meta.id;
}

export function buildDlChainFilter(
  meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">,
): Set<string> | undefined {
  const chainIds = new Set<string>();
  for (const contract of getTrackedContracts(meta)) {
    const chainId = resolveChainId(contract.chain);
    if (!chainId) continue;
    if (CHAIN_META[chainId]) {
      chainIds.add(chainId);
    }
  }

  return chainIds.size > 0 ? chainIds : undefined;
}

export function getTrackedContractAddresses(
  meta: Pick<StablecoinMeta, "contracts" | "tradedContracts">,
  chain?: string | null,
): string[] {
  const normalizedChain = chain ? (resolveChainId(chain) ?? chain.toLowerCase()) : null;

  return getTrackedContracts(meta)
    .filter(
      (contract) =>
        !normalizedChain || (resolveChainId(contract.chain) ?? contract.chain.toLowerCase()) === normalizedChain,
    )
    .map((contract) => normalizeTokenAddress(contract.address))
    .filter(Boolean);
}
