import type { ExitRouteOutput } from "../types/exit-route";
import { compareText } from "../types/safety-score-v9-fact-primitives";

/**
 * Resolve the semantic asset identities used to value an exit output.
 * Tracked stablecoin ids are canonical when present; their chain token keys
 * are execution provenance for the same asset, not additional basket legs.
 */
export function resolvedExitRouteOutputAssetKeys(output: ExitRouteOutput): string[] | null {
  if (output.kind !== "tracked-stablecoin" && output.kind !== "fiat" && output.kind !== "collateral") {
    return null;
  }

  const assetKeys =
    output.kind === "tracked-stablecoin" && (output.trackedAssetIds?.length ?? 0) > 0
      ? output.trackedAssetIds!
      : [
          ...(output.assetKeys ?? []),
          ...(output.kind === "fiat" && output.currency ? [`fiat:${output.currency}`] : []),
        ];
  if (assetKeys.length === 0) return null;
  return [...new Set(assetKeys)].sort(compareText);
}
