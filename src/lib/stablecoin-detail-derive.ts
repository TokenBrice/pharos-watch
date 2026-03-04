import { derivePegRates, getPegReference, type PegRateSource } from "./peg-rates";
import { TIER_BORDER, getScoreTier } from "./severity-colors";
import type { DexLiquidityData, PegAssetBase, StablecoinMeta } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * DAY_MS;
const NINETY_DAY_TOLERANCE_MS = 7 * DAY_MS;

export interface SupplyHistoryEntry {
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

export interface PegReferenceContext {
  pegReference: number;
  pegRates: Record<string, number>;
  pegRateSources: Record<string, PegRateSource>;
  pegRateSource: PegRateSource | undefined;
}

function toEpochMs(rawDate: number): number {
  return new Date(rawDate).getTime();
}

export function deriveSupplyFromMarketCap(
  marketCapUsd: number,
  priceUsd: number | null | undefined,
): number {
  return typeof priceUsd === "number" && priceUsd > 0 ? marketCapUsd / priceUsd : marketCapUsd;
}

export function hasPositivePegReference(pegReference: number): boolean {
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

export function derivePegScoreBorderClass(pegScore: number | null | undefined): string {
  if (pegScore == null) return "";
  if (pegScore >= 90) return "border-l-2 border-l-green-500";
  if (pegScore >= 70) return "border-l-2 border-l-amber-500";
  return "border-l-2 border-l-red-500";
}

export function deriveLiquidityBorderClass(liquidity: DexLiquidityData | undefined): string {
  if (liquidity == null || liquidity.liquidityScore === null) return "";
  return `border-l-2 ${TIER_BORDER[getScoreTier(liquidity.liquidityScore)]}`;
}
