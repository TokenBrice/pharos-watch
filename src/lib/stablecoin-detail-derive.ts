import { derivePegRates, getPegReference, type PegRateSource } from "@shared/lib/peg-rates";
import type { PegAssetBase, StablecoinMeta } from "@shared/types";
interface PegReferenceInputs {
  assets: PegAssetBase[];
  pegType: string | undefined;
  commodityOunces?: number;
  fallbackRates?: Record<string, number>;
  metaById?: ReadonlyMap<string, Pick<StablecoinMeta, "commodityOunces">>;
}

interface PegReferenceContext {
  pegReference: number;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateSource: PegRateSource | undefined;
}

export function deriveSupplyFromMarketCap(
  marketCapUsd: number | null | undefined,
  priceUsd: number | null | undefined,
): number | null {
  if (typeof marketCapUsd !== "number" || marketCapUsd <= 0) return null;
  if (typeof priceUsd !== "number" || priceUsd <= 0) return null;
  return marketCapUsd / priceUsd;
}

function hasPositivePegReference(pegReference: number): boolean {
  return Number.isFinite(pegReference) && pegReference > 0;
}

export function deriveDeviationBps(
  priceUsd: number | null | undefined,
  pegReference: number,
): number {
  if (priceUsd == null || !hasPositivePegReference(pegReference)) return 0;
  return Math.round(((priceUsd - pegReference) / pegReference) * 10_000);
}

export function deriveGaugeDeviationBps(
  deviationBps: number,
  isNavToken: boolean,
): number {
  return isNavToken ? 0 : deviationBps;
}

export function derivePegReferenceContext({
  assets,
  pegType,
  commodityOunces,
  fallbackRates,
  metaById,
}: PegReferenceInputs): PegReferenceContext {
  const { rates, sources } = derivePegRates(assets, metaById, fallbackRates);
  return {
    pegReference: getPegReference(pegType, rates, commodityOunces),
    pegRates: rates,
    pegRateSources: sources,
    pegRateSource: pegType ? sources[pegType] : undefined,
  };
}
