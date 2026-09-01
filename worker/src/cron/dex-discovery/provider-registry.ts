import {
  DEX_DISCOVERY_PROVIDER_REGISTRY,
  type DexDiscoveryProvider,
  type DexDiscoveryProviderAdapter,
} from "@shared/lib/dex-deployment-coverage";
import { BTCUSD_PUBLIC_HTTPS_DISCOVERY_PROVIDER_SLOT } from "./providers/btcusd-public-https";
import { SOROBAN_EXHAUSTIVE_DISCOVERY_PROVIDER_SLOT } from "./providers/soroban-exhaustive";

const leafOverrides: Partial<Record<
  DexDiscoveryProvider,
  Pick<DexDiscoveryProviderAdapter, "lifecycle" | "supports">
>> = {
  "soroban-exhaustive": SOROBAN_EXHAUSTIVE_DISCOVERY_PROVIDER_SLOT,
  "btcusd-public-https": BTCUSD_PUBLIC_HTTPS_DISCOVERY_PROVIDER_SLOT,
};

/** Runtime view of the single shared descriptor registry plus leaf-owned activation slots. */
export const DEX_DISCOVERY_PROVIDER_RUNTIME_REGISTRY: readonly DexDiscoveryProviderAdapter[] =
  DEX_DISCOVERY_PROVIDER_REGISTRY.map((provider) => ({
    ...provider,
    ...(leafOverrides[provider.providerId] ?? {}),
  }));

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
