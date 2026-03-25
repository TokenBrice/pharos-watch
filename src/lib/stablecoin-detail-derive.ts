import { derivePegRates, getPegReference, type PegRateSource } from "@shared/lib/peg-rates";
import type { PegAssetBase, StablecoinMeta } from "@shared/types";
import { NINETY_DAYS_MS, WEEK_MS } from "./constants";

const NINETY_DAY_TOLERANCE_MS = WEEK_MS;

interface SupplyHistoryEntry {
  date: number;
  circulatingUsd: number;
}

interface PegReferenceInputs {
  assets: PegAssetBase[];
  pegType: string | undefined;
  commodityOunces?: number;
  fallbackRates?: Record<string, number>;
  metaById?: Map<string, StablecoinMeta>;
}

interface PegReferenceContext {
  pegReference: number;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateSource: PegRateSource | undefined;
}

function toEpochMs(rawDate: number): number {
  return new Date(rawDate).getTime();
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

export function derivePrev90dReferenceMcap(
  supplyHistory: SupplyHistoryEntry[],
  nowMs: number,
): number {
  if (supplyHistory.length === 0) return 0;

  const targetMs = nowMs - NINETY_DAYS_MS;
  let closest = supplyHistory[0];

  for (const entry of supplyHistory) {
    if (Math.abs(toEpochMs(entry.date) - targetMs) < Math.abs(toEpochMs(closest.date) - targetMs)) {
      closest = entry;
    }
  }

  if (Math.abs(toEpochMs(closest.date) - targetMs) > NINETY_DAY_TOLERANCE_MS) return 0;
  return closest.circulatingUsd;
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
