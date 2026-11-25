import { isFixedDecimalDeployment } from "@shared/lib/deployment-amounts";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { normalizeChainId } from "@shared/types/chain-identity";
import { buildChainAddressKey } from "../dex-liquidity/token-resolution";
import { getTrackedContracts } from "./identity";

export interface TrackedOptionalAsset {
  stablecoinId: string;
  symbol: string;
}

interface TrackedMorphoAsset extends TrackedOptionalAsset {
  decimals: number;
}

interface TrackedMorphoFilters {
  assetsByChainAddress: Map<string, TrackedMorphoAsset>;
}

export function buildMorphoFilters(): TrackedMorphoFilters {
  const stablecoins = ACTIVE_STABLECOINS.filter(
    (meta) => meta.flags.pegCurrency !== "GOLD" && meta.flags.pegCurrency !== "SILVER",
  );
  const assetsByChainAddress = new Map<string, TrackedMorphoAsset>();
  for (const meta of stablecoins) {
    for (const contract of getTrackedContracts(meta)) {
      const chain = normalizeChainId(contract.chain);
      const address = contract.address?.trim() ?? "";
      if (!chain || !address || !isFixedDecimalDeployment(contract)) continue;
      assetsByChainAddress.set(buildChainAddressKey(chain, address), {
        stablecoinId: meta.id,
        symbol: meta.symbol,
        decimals: contract.decimals,
      });
    }
  }
  return { assetsByChainAddress };
}

export function resolveMorphoTrackedAsset(
  filters: TrackedMorphoFilters,
  chain: string,
  assetAddress: string | null | undefined,
): TrackedMorphoAsset | null {
  const address = assetAddress?.trim() ?? "";
  return address ? (filters.assetsByChainAddress.get(buildChainAddressKey(chain, address)) ?? null) : null;
}

export function resolveVaultDepositToken(
  vault: { depositToken?: { contractAddress?: string | null } | null },
  chain: string,
  lookup: Map<string, TrackedOptionalAsset>,
): TrackedOptionalAsset | null {
  const address = vault.depositToken?.contractAddress?.trim() ?? "";
  return address ? (lookup.get(buildChainAddressKey(chain, address)) ?? null) : null;
}
