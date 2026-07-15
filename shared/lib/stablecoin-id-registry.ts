import { DEAD_STABLECOINS } from "./dead-stablecoins";
import { PSI_ELIGIBLE_META_BY_ID, PSI_ELIGIBLE_STABLECOINS } from "./psi-eligible";
import { SHADOW_STABLECOINS } from "./shadow-stablecoins";
import { READABLE_META_BY_ID, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "./stablecoins/registry";
import type { StablecoinMeta } from "../types";

/** Cross-provider metadata seed: every tracked lifecycle plus PSI-only shadow assets. Excludes dead assets. */
export const ALL_LIVE_COINS: readonly StablecoinMeta[] = [...TRACKED_STABLECOINS, ...SHADOW_STABLECOINS];

/** Lookup of every live coin (tracked + shadow) by canonical id. Includes shadow assets that are NOT in the public readback. */
const registryById = new Map<string, StablecoinMeta>();
/** Tracked-only registry: every catalog lifecycle, no shadow assets. */
export const TRACKED_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = TRACKED_META_BY_ID;
/** Public-readback registry: all post-launch tracked records. Excludes pre-launch and shadow-only ids. */
export const READABLE_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = READABLE_META_BY_ID;
/** PSI universe: active tracked coins plus PSI-only shadow assets (used for systemic-importance calculations). */
export const PSI_INCLUSIVE_REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = PSI_ELIGIBLE_META_BY_ID;
/** Reverse index: DefiLlama numeric id → meta. Guaranteed unique (throws at module load on collision). */
const registryByLlamaId = new Map<string, StablecoinMeta>();
/** Reverse index: CoinGecko id → meta. Guaranteed unique (throws at module load on collision). */
const registryByGeckoId = new Map<string, StablecoinMeta>();
/** Reverse index: CoinMarketCap slug → meta. Guaranteed unique (throws at module load on collision). */
const registryByCmcSlug = new Map<string, StablecoinMeta>();

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
  if (registryById.has(meta.id)) {
    throw new Error(`[stablecoin-id-registry] Duplicate canonical id: ${meta.id}`);
  }
  registryById.set(meta.id, meta);

  if (meta.llamaId) {
    setUniqueExternalId(registryByLlamaId, "llamaId", meta.llamaId, meta);
  }

  if (meta.geckoId) {
    setUniqueExternalId(registryByGeckoId, "geckoId", meta.geckoId, meta);
  }

  if (meta.cmcSlug) {
    setUniqueExternalId(registryByCmcSlug, "cmcSlug", meta.cmcSlug, meta);
  }
}

for (const [llamaId, meta] of registryByLlamaId) {
  const canonicalMatch = registryById.get(llamaId);
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

export const REGISTRY_BY_ID: ReadonlyMap<string, StablecoinMeta> = registryById;
export const REGISTRY_BY_LLAMA_ID: ReadonlyMap<string, StablecoinMeta> = registryByLlamaId;
export const REGISTRY_BY_GECKO_ID: ReadonlyMap<string, StablecoinMeta> = registryByGeckoId;
export const REGISTRY_BY_CMC_SLUG: ReadonlyMap<string, StablecoinMeta> = registryByCmcSlug;

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

/** Resolve any tracked canonical stablecoin ID across every lifecycle state. */
export function resolveTrackedStablecoinId(input: string): StablecoinIdResolution | null {
  return resolveFromRegistry(TRACKED_REGISTRY_BY_ID, input);
}

/** Resolve public readback IDs: all post-launch tracked records, excluding pre-launch and shadow-only IDs. */
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
