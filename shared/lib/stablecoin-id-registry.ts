import { DEAD_STABLECOINS } from "./dead-stablecoins";
import { PSI_ELIGIBLE_META_BY_ID, PSI_ELIGIBLE_STABLECOINS } from "./psi-eligible";
import { SHADOW_STABLECOINS } from "./shadow-stablecoins";
import { READABLE_META_BY_ID, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "./stablecoins/registry";
import type { StablecoinMeta } from "../types";

/** Cross-provider live metadata seed: tracked active/frozen/pre-launch assets plus PSI-only shadow assets. Excludes dead assets. */
export const ALL_LIVE_COINS: StablecoinMeta[] = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS];

/** Lookup of every live coin (tracked + shadow) by canonical id. Includes shadow assets that are NOT in the public readback. */
export const REGISTRY_BY_ID: Map<string, StablecoinMeta> = new Map();
/** Tracked-only registry: active + frozen + pre-launch, no shadow assets. */
export const TRACKED_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = TRACKED_META_BY_ID;
/** Public-readback registry: active + frozen tracked coins. Excludes pre-launch and shadow-only ids. */
export const READABLE_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = READABLE_META_BY_ID;
/** PSI universe: active tracked coins plus PSI-only shadow assets (used for systemic-importance calculations). */
export const PSI_INCLUSIVE_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = PSI_ELIGIBLE_META_BY_ID;
/** Reverse index: DefiLlama numeric id → meta. Guaranteed unique (throws at module load on collision). */
export const REGISTRY_BY_LLAMA_ID: Map<string, StablecoinMeta> = new Map();
/** Reverse index: CoinGecko id → meta. Guaranteed unique (throws at module load on collision). */
export const REGISTRY_BY_GECKO_ID: Map<string, StablecoinMeta> = new Map();
/** Reverse index: CoinMarketCap slug → meta. Guaranteed unique (throws at module load on collision). */
export const REGISTRY_BY_CMC_SLUG: Map<string, StablecoinMeta> = new Map();

function setUniqueExternalId(
  registry: Map<string, StablecoinMeta>,
  provider: "llamaId" | "geckoId" | "cmcSlug",
  externalId: string,
  meta: StablecoinMeta,
): void {
  const existing = registry.get(externalId);
  if (existing) {
    throw new Error(`[stablecoin-id-registry] Duplicate ${provider}: ${externalId} (${existing.id}, ${meta.id})`);
  }
  registry.set(externalId, meta);
}

function assertUniqueDeadLlamaIds(): void {
  const seenDeadLlamaIds = new Map<string, string>();

  for (const dead of DEAD_STABLECOINS) {
    if (!dead.llamaId) {
      continue;
    }

    const existing = seenDeadLlamaIds.get(dead.llamaId);
    if (existing) {
      throw new Error(`[stablecoin-id-registry] Duplicate dead llamaId: ${dead.llamaId} (${existing}, ${dead.name})`);
    }

    seenDeadLlamaIds.set(dead.llamaId, dead.name);
  }
}

for (const meta of ALL_LIVE_COINS) {
  if (REGISTRY_BY_ID.has(meta.id)) {
    throw new Error(`[stablecoin-id-registry] Duplicate canonical id: ${meta.id}`);
  }
  REGISTRY_BY_ID.set(meta.id, meta);

  if (meta.llamaId) {
    setUniqueExternalId(REGISTRY_BY_LLAMA_ID, "llamaId", meta.llamaId, meta);
  }

  if (meta.geckoId) {
    setUniqueExternalId(REGISTRY_BY_GECKO_ID, "geckoId", meta.geckoId, meta);
  }

  if (meta.cmcSlug) {
    setUniqueExternalId(REGISTRY_BY_CMC_SLUG, "cmcSlug", meta.cmcSlug, meta);
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

assertUniqueDeadLlamaIds();

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
export function resolveStablecoinId(input: string): StablecoinIdResolution | null {
  return resolveReadableStablecoinId(input);
}

/** Historical PSI stablecoin id aliases. Maps legacy/post-collapse ids to the canonical id used in PSI supply/shadow coverage. */
const PSI_STABLECOIN_ID_ALIASES = new Map<string, string>([
  // UST historical depeg rows were recorded under the post-collapse legacy id,
  // while PSI supply/shadow coverage now keys the asset as `ust-terra`.
  ["ust-terra-classic", "ust-terra"],
]);

/** Resolve a PSI stablecoin id to its canonical form, applying any known historical aliases. */
export function canonicalizePsiStablecoinId(stablecoinId: string): string {
  return PSI_STABLECOIN_ID_ALIASES.get(stablecoinId) ?? stablecoinId;
}
