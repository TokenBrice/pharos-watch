import type { StablecoinClientDetailMeta } from "../../types/stablecoin-client-meta";
import { CLIENT_TRACKED_META_BY_ID } from "./client-registry";

/**
 * Load evidence for one known coin without putting the per-coin import context
 * in the list-only registry's dependency graph.
 */
export async function loadClientStablecoinDetail(id: string): Promise<StablecoinClientDetailMeta | null> {
  const listMeta = CLIENT_TRACKED_META_BY_ID.get(id);
  if (!listMeta) return null;
  // The runtime-selected ID keeps the evidence corpus in per-file chunks.
  const detailAsset: unknown = await import(`../../data/stablecoins/coins.client.detail/${id}.generated.json`);
  if (detailAsset === null || typeof detailAsset !== "object" || !("default" in detailAsset)) {
    throw new Error(`[client-registry] detail projection ID mismatch for ${id}`);
  }
  const detail = detailAsset.default;
  if (!detail || typeof detail !== "object" || Array.isArray(detail) || !("id" in detail) || detail.id !== id) {
    throw new Error(`[client-registry] detail projection ID mismatch for ${id}`);
  }
  // Projection fields are authored and validated by the client-data generator.
  return { ...listMeta, ...(detail as Partial<StablecoinClientDetailMeta>) };
}
