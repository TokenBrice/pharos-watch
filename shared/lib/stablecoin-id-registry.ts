import { DEAD_STABLECOINS } from "./dead-stablecoins";
import { SHADOW_STABLECOINS } from "./shadow-stablecoins";
import { TRACKED_STABLECOINS } from "./stablecoins";
import type { StablecoinMeta } from "../types";

export const ALL_LIVE_COINS: StablecoinMeta[] = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS];

export const REGISTRY_BY_ID: Map<string, StablecoinMeta> = new Map();
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

for (const dead of DEAD_STABLECOINS) {
  if (dead.llamaId) {
    DEAD_BY_LLAMA_ID.set(dead.llamaId, dead.name);
  }
}

/** Supported external ID providers. Add new providers here as they are integrated. */
export type ExternalIdProvider = "defillama" | "coingecko" | "cmc";

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

/** Resolve a canonical stablecoin ID. Returns null for unknown IDs. */
export function resolveStablecoinId(
  input: string,
): { canonicalId: string } | null {
  if (REGISTRY_BY_ID.has(input)) {
    return { canonicalId: input };
  }

  return null;
}

export function getLlamaId(canonicalId: string): string | null {
  const meta = REGISTRY_BY_ID.get(canonicalId);
  return meta?.llamaId ?? null;
}
