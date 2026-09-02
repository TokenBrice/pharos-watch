import {
  DEX_DISCOVERY_PROVIDER_REGISTRY,
  type DexDiscoveryProvider,
} from "@shared/lib/dex-deployment-coverage";

/** Runtime view of the shared provider descriptor registry. */
export const DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY = DEX_DISCOVERY_PROVIDER_REGISTRY;

export function getRuntimeDexDiscoveryProviders(
  chain: string,
  address?: string,
): DexDiscoveryProvider[] {
  return DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY
    .filter((provider) => provider.lifecycle === "active" && provider.supports(chain, address))
    .sort((left, right) => left.executionOrder - right.executionOrder)
    .map((provider) => provider.providerId);
}

export function isRuntimeDexDiscoveryProviderExhaustive(providerId: DexDiscoveryProvider): boolean {
  return DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY.find((provider) => provider.providerId === providerId)?.scope ===
    "exhaustive";
}

export function isRuntimeCensusProviderSetSupersededByRegistry(
  chain: string,
  address: string | undefined,
  persistedProviderCount: number,
): boolean {
  return persistedProviderCount === 0 && getRuntimeDexDiscoveryProviders(chain, address).length > 0;
}
