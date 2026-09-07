import type {
  StablecoinClientDetailMeta,
  StablecoinClientListMeta,
} from "../../types/stablecoin-client-meta";
import clientListAsset from "../../data/stablecoins/coins.client.list.generated.json";
import canonicalOrderAsset from "../../data/stablecoins/canonical-order.json";
import { buildStablecoinRegistryIndexes } from "./registry-indexes";
import { isActiveStablecoinMeta } from "./status";

/**
 * Eager client-side stablecoin list.
 *
 * The list contains identity, lifecycle, filter, chain, and compact badge
 * fields only. Reserve, compliance, yield, and review evidence is emitted as
 * one JSON file per coin and loaded through `loadClientStablecoinDetail`.
 */

const CANONICAL_ORDER = canonicalOrderAsset as readonly string[];
const registry = buildStablecoinRegistryIndexes(clientListAsset as StablecoinClientListMeta[], {
  canonicalOrder: CANONICAL_ORDER,
  isActive: isActiveStablecoinMeta,
  canonicalOrderErrorPrefix: "[client-registry] ",
});

/** Tracked stablecoins in canonical market-cap order (compact list projection). */
export const CLIENT_TRACKED_STABLECOINS: readonly StablecoinClientListMeta[] = registry.tracked.stablecoins;

/** Map of stablecoin ID -> compact client metadata. */
export const CLIENT_TRACKED_META_BY_ID: ReadonlyMap<string, StablecoinClientListMeta> = registry.tracked.metaById;

/** Set of all tracked stablecoin IDs, across every lifecycle state. */
export const CLIENT_TRACKED_IDS: ReadonlySet<string> = registry.tracked.ids;

/** Active stablecoins (excludes every non-active lifecycle state). */
export const CLIENT_ACTIVE_STABLECOINS: readonly StablecoinClientListMeta[] = registry.active.stablecoins;

/** Set of active stablecoin IDs. */
export const CLIENT_ACTIVE_IDS: ReadonlySet<string> = registry.active.ids;

/** Map of active stablecoin ID -> compact client metadata. */
export const CLIENT_ACTIVE_META_BY_ID: ReadonlyMap<string, StablecoinClientListMeta> = registry.active.metaById;

/**
 * Load the evidence-bearing projection for one known coin. Dynamic JSON
 * imports become per-file chunks in the static export, so list/filter routes
 * never pull the full detail corpus into their initial client chunk.
 */
export async function loadClientStablecoinDetail(id: string): Promise<StablecoinClientDetailMeta | null> {
  if (!CLIENT_TRACKED_IDS.has(id)) return null;
  const listMeta = CLIENT_TRACKED_META_BY_ID.get(id);
  if (!listMeta) return null;
  // The runtime-selected ID is required here: a static import would eagerly
  // include all 406 detail files in every browser chunk.
  const detailAsset = await import(`../../data/stablecoins/coins.client.detail/${id}.generated.json`);
  const detail = detailAsset.default as Partial<StablecoinClientDetailMeta>;
  if (detail.id !== id) {
    throw new Error(`[client-registry] detail projection ID mismatch for ${id}`);
  }
  return { ...listMeta, ...detail };
}

export type {
  StablecoinClientDetailMeta,
  StablecoinClientListMeta,
  StablecoinClientMeta,
} from "../../types/stablecoin-client-meta";
