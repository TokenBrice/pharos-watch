import { readDeviationProjection } from "./depeg-signals";
import { getCommodityOuncesAtQuote } from "./commodity-median";
import { isParityPrice } from "./peg-rates";
import type { CurrentPeg } from "../types/current-peg";

type PegProjection = Partial<Pick<CurrentPeg, "currentDeviationBps" | "admittedDeviationBps" |
  "currentPriceUnavailable" | "pegReferenceUnavailable">> & {
  referenceAdmission?: CurrentPeg["referenceAdmission"] | null;
};

/** Recheck the quote unit when reading a block written under an older parity policy. */
export function hasComparablePegQuote(asset: Parameters<typeof isParityPrice>[0]): boolean {
  return isParityPrice(asset) && getCommodityOuncesAtQuote(undefined, {
    assetId: asset.id, commodityEntitlement: asset.commodityEntitlement, quoteObservedAtSec: asset.priceObservedAt,
  }) != null;
}

/** A missing projection predates admission. An explicit unavailable result always wins. */
export function projectCurrentPegDeviation(
  peg: PegProjection | null | undefined, fixedUsd: boolean, quoteObservedAt: number | null | undefined,
): number | null {
  if (!peg || peg.currentPriceUnavailable || peg.pegReferenceUnavailable) return null;
  const projection = readDeviationProjection(peg, fixedUsd, quoteObservedAt);
  if (projection !== undefined) return projection;
  const legacy = peg.currentDeviationBps;
  return typeof legacy === "number" && Number.isFinite(legacy) ? legacy : null;
}
