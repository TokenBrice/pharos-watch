---
title: "Remap DefiLlama IDs in sync-stablecoins via registry"
agent: "codex"
reasoning_effort: "high"
done: false
---

## Goal

Ensure the main data sync cron remaps DefiLlama's numeric asset IDs to canonical internal IDs immediately after fetch, so all downstream processing uses canonical IDs.

## Task

1. **Read `worker/src/cron/sync-stablecoins.ts`** fully to understand the data flow. (Note: this is a flat file, NOT `sync-stablecoins/index.ts`.) The main sync function fetches from `${DEFILLAMA_BASE}/stablecoins?includePrices=true` and parses `peggedAssets` from the JSON response as `llamaData`.

2. Find the remap insertion point. The function parses the response around line ~319, then runs several processing steps. Insert the remap **after** `normalizeChainCirculating(llamaData.peggedAssets)` (around line ~355) and **before** the supplemental asset merge (around line ~357). This ensures structurally invalid assets are already filtered, but the remap happens before `applyTrackedAssetOverrides()` which uses `TRACKED_META_BY_ID.get(String(asset.id))`.
   ```ts
   import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";

   // Remap DL numeric IDs to canonical IDs
   for (const asset of peggedAssets) {
     const mapped = REGISTRY_BY_LLAMA_ID.get(String(asset.id));
     if (mapped) {
       asset.id = mapped.id;  // Replace DL ID with canonical ID
     }
     // Unmapped assets flow through with their original IDs
     // (they'll be filtered by TRACKED_IDS check downstream)
   }
   ```

3. This remap must happen BEFORE:
   - `applyTrackedAssetOverrides()` (if it exists)
   - Price enrichment (`fetchDualPrimaryPrices`, `enrichMissingPrices`)
   - Cache writes (`savePriceCache`)
   - Any DB writes

4. Verify that price cache keys, supply data keys, and all maps use the remapped `asset.id` after this point.

5. **Why this is a no-op right now:** `REGISTRY_BY_LLAMA_ID` is empty until Phase 1 TICKET-004 populates `llamaId` on stablecoin entries. Once populated, the loop will start matching — but the remapped IDs will still equal the current `id` values until Phase 3 switches them. After Phase 3, the remap becomes essential: DL returns numeric IDs like `"1"` which must be mapped to canonical IDs like `"usdt-tether"` before downstream processing.

## Acceptance Criteria

- `npm run build` exits 0
- `cd worker && npx tsc --noEmit` exits 0
- `npm test` exits 0
- `grep -n 'REGISTRY_BY_LLAMA_ID' worker/src/cron/sync-stablecoins.ts` shows the import and usage
- The remap happens before any enrichment or cache writes
