import type { ExitRouteOutput } from "../types/exit-route";
import { compareCodeUnits as compareText } from "./compare";

/**
 * Resolve the semantic asset identities used to value an exit output.
 * Tracked stablecoin ids are canonical when present; their chain token keys
 * are execution provenance for the same asset, not additional basket legs.
 */
export function resolvedExitRouteOutputAssetKeys(output: ExitRouteOutput): string[] | null {
  if (output.kind !== "tracked-stablecoin" && output.kind !== "fiat" && output.kind !== "collateral" && output.kind !== "physical-commodity-delivery") {
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

/** A payout in the input asset or its pass-through receipt keeps the holder's exposure. */
export function isDexExitPayoutConversion(
  inputAssetId: string,
  outputAssetIds: readonly string[],
  metaById: ReadonlyMap<string, { variantOf?: string; variantKind?: string }>,
): boolean {
  return outputAssetIds.some((outputId) => {
    const seen = new Set<string>();
    let id: string | undefined = outputId;
    while (id && !seen.has(id)) {
      if (id === inputAssetId) return true;
      seen.add(id);
      const meta = metaById.get(id);
      if (meta?.variantKind !== "savings-passthrough" && meta?.variantKind !== "pure-wrapper") return false;
      id = meta.variantOf;
    }
    return false;
  });
}
