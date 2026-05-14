import { DEAD_STABLECOINS } from "./dead-stablecoins";
import { PSI_ELIGIBLE_META_BY_ID, PSI_ELIGIBLE_STABLECOINS } from "./psi-eligible";
import { SHADOW_STABLECOINS } from "./shadow-stablecoins";
import { READABLE_META_BY_ID, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "./stablecoins";
import type { StablecoinMeta } from "../types";

export const ALL_LIVE_COINS: StablecoinMeta[] = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS];

export const REGISTRY_BY_ID: Map<string, StablecoinMeta> = new Map();
export const TRACKED_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = TRACKED_META_BY_ID;
export const READABLE_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = READABLE_META_BY_ID;
export const PSI_INCLUSIVE_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = PSI_ELIGIBLE_META_BY_ID;
export const REGISTRY_BY_LLAMA_ID: Map<string, StablecoinMeta> = new Map();
export const REGISTRY_BY_GECKO_ID: Map<string, StablecoinMeta> = new Map();
export const REGISTRY_BY_CMC_SLUG: Map<string, StablecoinMeta> = new Map();
export const DEAD_BY_LLAMA_ID: Map<string, string> = new Map();

for (const meta of ALL_LIVE_COINS) {
  if (REGISTRY_BY_ID.has(meta.id)) {
    throw new Error(`[stablecoin-id-registry] Duplicate canonical id: ${meta.id}`);
  }
  REGISTRY_BY_ID.set(meta.id, meta);

  if (meta.llamaId) {
    if (REGISTRY_BY_LLAMA_ID.has(meta.llamaId)) {
      throw new Error(`[stablecoin-id-registry] Duplicate llamaId: ${meta.llamaId}`);
    }
    REGISTRY_BY_LLAMA_ID.set(meta.llamaId, meta);
  }

  if (meta.geckoId) {
    REGISTRY_BY_GECKO_ID.set(meta.geckoId, meta);
  }

  if (meta.cmcSlug) {
    REGISTRY_BY_CMC_SLUG.set(meta.cmcSlug, meta);
  }
}

for (const [llamaId, meta] of REGISTRY_BY_LLAMA_ID) {
  const canonicalMatch = REGISTRY_BY_ID.get(llamaId);
  if (canonicalMatch && canonicalMatch.id !== meta.id) {
    throw new Error(
      `[stablecoin-id-registry] Ambiguous id: llamaId ${llamaId} maps to ${meta.id} but canonical id belongs to ${canonicalMatch.id}`,
    );
  }
}

for (const shadow of SHADOW_STABLECOINS) {
  if (!PSI_INCLUSIVE_REGISTRY_BY_ID.has(shadow.id)) {
    throw new Error(`[stablecoin-id-registry] Shadow id missing from PSI-inclusive registry: ${shadow.id}`);
  }
}

if (PSI_INCLUSIVE_REGISTRY_BY_ID.size !== PSI_ELIGIBLE_STABLECOINS.length) {
  throw new Error("[stablecoin-id-registry] PSI-inclusive registry has duplicate canonical ids");
}

for (const dead of DEAD_STABLECOINS) {
  if (dead.llamaId) {
    DEAD_BY_LLAMA_ID.set(dead.llamaId, dead.name);
  }
}

/** Supported external ID providers. Add new providers here as they are integrated. */
export type ExternalIdProvider = "defillama" | "coingecko" | "cmc";
export type StablecoinIdResolution = { canonicalId: string };

function resolveFromRegistry(
  registry: ReadonlyMap<string, StablecoinMeta>,
  input: string,
): StablecoinIdResolution | null {
  if (registry.has(input)) {
    return { canonicalId: input };
  }

  return null;
}

/**
 * Resolve an external provider ID to a canonical StablecoinMeta.
 * Use this instead of ad-hoc geckoId/cmcSlug matching scattered in code.
 *
 * @example resolveByExternalId("defillama", "1")
 * @example resolveByExternalId("coingecko", "tether")
 */
export function resolveByExternalId(
  provider: ExternalIdProvider,
  externalId: string,
): StablecoinMeta | null {
  switch (provider) {
    case "defillama":
      return REGISTRY_BY_LLAMA_ID.get(externalId) ?? null;
    case "coingecko":
      return REGISTRY_BY_GECKO_ID.get(externalId) ?? null;
    case "cmc":
      return REGISTRY_BY_CMC_SLUG.get(externalId) ?? null;
  }
}

/** Resolve any tracked canonical stablecoin ID, including pre-launch and frozen IDs. */
export function resolveTrackedStablecoinId(input: string): StablecoinIdResolution | null {
  return resolveFromRegistry(TRACKED_REGISTRY_BY_ID, input);
}

/** Resolve public readback IDs: active + frozen tracked coins, excluding pre-launch and shadow-only IDs. */
export function resolveReadableStablecoinId(input: string): StablecoinIdResolution | null {
  return resolveFromRegistry(READABLE_REGISTRY_BY_ID, input);
}

/** Resolve the PSI universe: active tracked coins plus PSI-only shadow assets. */
export function resolvePsiInclusiveStablecoinId(input: string): StablecoinIdResolution | null {
  return resolveFromRegistry(PSI_INCLUSIVE_REGISTRY_BY_ID, input);
}

/** Resolve a public readback stablecoin ID. Returns null for unknown, pre-launch, and shadow-only IDs. */
export function resolveStablecoinId(
  input: string,
): StablecoinIdResolution | null {
  return resolveReadableStablecoinId(input);
}

export function getLlamaId(canonicalId: string): string | null {
  const meta = REGISTRY_BY_ID.get(canonicalId);
  return meta?.llamaId ?? null;
}
