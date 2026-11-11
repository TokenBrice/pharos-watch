import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { buildChainAddressKey } from "../dex-liquidity/token-resolution";
import { buildTrackedYieldAssetIndex } from "./identity";

export interface TrackedOptionalAsset {
  stablecoinId: string;
  symbol: string;
}

interface TrackedMorphoFilters {
  symbols: string[];
  assetsByChainAddress: Map<string, TrackedOptionalAsset>;
}

export function buildMorphoFilters(): TrackedMorphoFilters {
  const stablecoins = ACTIVE_STABLECOINS.filter(
    (meta) => meta.flags.pegCurrency !== "GOLD" && meta.flags.pegCurrency !== "SILVER",
  );
  return {
    symbols: [...new Set(stablecoins.map((meta) => meta.symbol))].sort((a, b) => a.localeCompare(b)),
    assetsByChainAddress: buildTrackedYieldAssetIndex(stablecoins),
  };
}

export function resolveMorphoTrackedAsset(
  filters: TrackedMorphoFilters,
  chain: string,
  asset: { symbol: string; address?: string | null },
): TrackedOptionalAsset | null {
  const address = asset.address?.trim() ?? "";
  if (address) {
    const byAddress = filters.assetsByChainAddress.get(buildChainAddressKey(chain, address));
    if (byAddress) return byAddress;
  }

  return null;
}

export function resolveVaultDepositToken(
  vault: { depositToken?: { contractAddress?: string | null } | null },
  chain: string,
  lookup: Map<string, TrackedOptionalAsset>,
): TrackedOptionalAsset | null {
  const address = vault.depositToken?.contractAddress?.trim() ?? "";
  return address ? (lookup.get(buildChainAddressKey(chain, address)) ?? null) : null;
}
