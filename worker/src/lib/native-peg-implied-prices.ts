import type { PriceReferenceType } from "./price-validation";
import { fetchCurrentNativePegQuotes, type NativePegQuoteFetchOptions } from "./native-peg-quotes";
import { midDivergenceBps } from "./price-divergence";

export const COINGECKO_NATIVE_IMPLIED_SOURCE = "coingecko-native-implied";
export const NATIVE_PEG_PRICE_GUARD_MAX_DRIFT_BPS = 75;

export interface NativePegImpliedUsdRequest {
  stablecoinId: string;
  geckoId?: string | null;
  pegCurrency?: string | null;
  pegType?: string | null;
}

export interface NativePegImpliedUsdQuote {
  stablecoinId: string;
  pegCurrency: string;
  vsCurrency?: string;
  nativePrice: number;
  priceUsd: number;
  updatedAt: number;
  referencePriceUsd: number;
  referenceType: PriceReferenceType;
}

function getReferenceTypeForPegType(
  pegType: string,
  validationReferences: {
    type: PriceReferenceType;
    typeByPeg?: Record<string, PriceReferenceType | undefined>;
  },
): PriceReferenceType {
  return validationReferences.typeByPeg?.[pegType] ?? validationReferences.type;
}

export function computePriceDivergenceBps(left: number, right: number): number | null {
  if (!Number.isFinite(left) || left <= 0 || !Number.isFinite(right) || right <= 0) {
    return null;
  }
  const divergenceBps = midDivergenceBps(left, right);
  return Number.isFinite(divergenceBps) ? Math.round(divergenceBps) : null;
}

export async function fetchCurrentNativePegImpliedUsdQuotes(
  requests: NativePegImpliedUsdRequest[],
  validationReferences?: {
    rates: Record<string, number>;
    type: PriceReferenceType;
    typeByPeg?: Record<string, PriceReferenceType | undefined>;
  },
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  options?: NativePegQuoteFetchOptions,
): Promise<Map<string, NativePegImpliedUsdQuote>> {
  if (!validationReferences) {
    return new Map();
  }

  const nativeQuotes = await fetchCurrentNativePegQuotes(requests, signal, coingeckoApiKey, options);
  if (nativeQuotes.size === 0) {
    return new Map();
  }

  const quotes = new Map<string, NativePegImpliedUsdQuote>();
  for (const request of requests) {
    const nativeQuote = nativeQuotes.get(request.stablecoinId);
    if (!nativeQuote) continue;

    const pegType = typeof request.pegType === "string" && request.pegType.length > 0 ? request.pegType : null;
    if (!pegType) continue;

    const referenceType = getReferenceTypeForPegType(pegType, validationReferences);
    if (referenceType !== "fresh" && referenceType !== "static") continue;

    const referencePriceUsd = validationReferences.rates[pegType];
    if (typeof referencePriceUsd !== "number" || !Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0) {
      continue;
    }

    const priceUsd = nativeQuote.price * referencePriceUsd;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    quotes.set(request.stablecoinId, {
      stablecoinId: request.stablecoinId,
      pegCurrency: nativeQuote.pegCurrency,
      vsCurrency: nativeQuote.vsCurrency,
      nativePrice: nativeQuote.price,
      priceUsd,
      updatedAt: nativeQuote.updatedAt,
      referencePriceUsd,
      referenceType,
    });
  }

  return quotes;
}
