import { deriveDepegSignal } from "@shared/lib/depeg-signals";
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

export function deriveDeviationBps(
  priceUsd: number | null | undefined,
  pegReference: number,
): number | null {
  if (priceUsd == null) return null;
  return deriveDepegSignal(priceUsd, pegReference)?.bps ?? null;
}

export function deriveGaugeDeviationBps(
  deviationBps: number | null,
  isNavToken: boolean,
): number {
  return isNavToken ? 0 : deviationBps ?? 0;
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
