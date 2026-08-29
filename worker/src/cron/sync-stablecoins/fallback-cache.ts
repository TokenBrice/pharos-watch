import { logWorkerEventArgs } from "../../lib/structured-log";
import { applyTrackedAssetOverrides } from "./phase-helpers";
import { loadPreviousStablecoinsById } from "./shared";
import type {
  FallbackCacheRestorationInput,
  FallbackCacheRestorationOutput,
} from "./fallback-types";

export async function restoreFallbackCacheState(
  input: FallbackCacheRestorationInput,
): Promise<FallbackCacheRestorationOutput> {
  const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(input.db);

  try {
    for (const asset of input.assets) {
      const prev = previousAssetsById.get(String(asset.id));
      if (prev?.chainCirculating) {
        asset.chainCirculating = prev.chainCirculating;
        asset.chains = prev.chains ?? [];
      }
      if (prev?.circulatingPrevDay) asset.circulatingPrevDay = prev.circulatingPrevDay;
      if (prev?.circulatingPrevWeek) asset.circulatingPrevWeek = prev.circulatingPrevWeek;
      if (prev?.circulatingPrevMonth) asset.circulatingPrevMonth = prev.circulatingPrevMonth;
    }
  } catch (error) {
    logWorkerEventArgs("handler", "warn", "[sync-stablecoins] Failed to restore stale cache data:", error);
  }

  applyTrackedAssetOverrides(input.assets);

  return { previousAssetsById, previousCacheState };
}
