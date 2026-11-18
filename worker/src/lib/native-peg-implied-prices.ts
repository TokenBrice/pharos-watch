import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { evaluateReferenceAdmission } from "@shared/lib/reference-admission";
import { getReferenceSessionState, type ReferenceSessionState } from "@shared/lib/reference-market-hours";
import type { ReferenceAdmission } from "@shared/types/reference-admission";
import type { PriceReferenceType, PriceValidationReferences } from "./price-validation";
import {
  fetchCurrentNativePegQuotes,
  type NativePegQuoteFetchOptions,
  type NativePegQuoteSession,
} from "./native-peg-quotes";
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
  updatedAt: number | null;
  nativeObservedAtSec: number;
  nativeFxObservedAtSec: number | null;
  nativeLegReason: "traded-pair" | "verified-conversion" | "native-lineage-unavailable" | "conversion-fx-unverified";
  referenceObservedAtSec: number | null;
  referenceSession: ReferenceSessionState;
  referenceAdmission: ReferenceAdmission;
  referencePriceUsd: number;
  referenceType: PriceReferenceType;
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
  validationReferences?: PriceValidationReferences,
  signal?: AbortSignal,
  coingeckoApiKey?: string | null,
  options?: NativePegQuoteFetchOptions,
  session?: NativePegQuoteSession,
): Promise<Map<string, NativePegImpliedUsdQuote>> {
  if (!validationReferences) {
    return new Map();
  }

  const nativeQuotes = await fetchCurrentNativePegQuotes(requests, signal, coingeckoApiKey, options, session);
  if (nativeQuotes.size === 0) {
    return new Map();
  }

  const quotes = new Map<string, NativePegImpliedUsdQuote>();
  const decisionAtSec = Math.floor(Date.now() / 1000);
  const referenceSession = getReferenceSessionState("fx", decisionAtSec);
  for (const request of requests) {
    const nativeQuote = nativeQuotes.get(request.stablecoinId);
    if (!nativeQuote) continue;

    const pegType = request.pegType;
    if (!pegType || nativeQuote.stablecoinId !== request.stablecoinId ||
      pegTypeFromCurrency(nativeQuote.pegCurrency) !== pegType ||
      nativeQuote.vsCurrency?.toUpperCase() !== nativeQuote.pegCurrency) continue;

    const referenceType = validationReferences.typeByPeg?.[pegType] ?? validationReferences.type;
    if (referenceType !== "fresh" && referenceType !== "static") continue;

    const referencePriceUsd = validationReferences.rates[pegType];
    if (typeof referencePriceUsd !== "number" || !Number.isFinite(referencePriceUsd) || referencePriceUsd <= 0) {
      continue;
    }

    const priceUsd = nativeQuote.price * referencePriceUsd;
    if (!Number.isFinite(priceUsd) || priceUsd <= 0) continue;

    const legacyObservedAt = validationReferences.updatedAtByPeg?.[pegType] ?? null;
    const evidence = validationReferences.fxReferenceEvidenceByPeg?.[pegType];
    const matchingEvidence = evidence?.generation && evidence.generation.trim() === evidence.generation &&
      evidence.observation.pegKey === pegType &&
      evidence.observation.usdPerUnit === referencePriceUsd &&
      (legacyObservedAt == null || legacyObservedAt === evidence.observation.observedAtSec)
      ? evidence : null;
    const referenceObservedAtSec = matchingEvidence?.observation.observedAtSec ?? legacyObservedAt;
    const referenceAdmission = evaluateReferenceAdmission({
      ...(referenceType === "fresh" && matchingEvidence
        ? {
          kind: "fx" as const, observation: matchingEvidence.observation, generation: matchingEvidence.generation,
          ...(referenceSession.open && matchingEvidence.sessionOpenedAtSec === referenceSession.sessionOpenedAtSec
            ? { preCloseUsdPerUnit: matchingEvidence.preCloseUsdPerUnit, firstInSessionObservedAtSec: matchingEvidence.firstInSessionObservedAtSec }
            : {}),
        }
        : { kind: "none" as const }),
      quoteObservedAtSec: nativeQuote.updatedAt,
      decisionAtSec,
      rawDeviationBps: null,
      purpose: "current",
    });
    const derivation = nativeQuote.derivation;
    const nativeFxObservedAtSec = derivation?.kind === "conversion" ? derivation.lineage.fxObservedAtSec ?? null : null;
    let nativeLegReason: NativePegImpliedUsdQuote["nativeLegReason"] = "native-lineage-unavailable";
    if (derivation?.kind === "traded-pair" && derivation.lineage.venue && derivation.lineage.pair) {
      nativeLegReason = "traded-pair";
    } else if (derivation?.kind === "conversion") {
      // The matching selected observation is the only provider FX evidence this stage can verify.
      nativeLegReason = nativeFxObservedAtSec != null && matchingEvidence &&
        nativeFxObservedAtSec === matchingEvidence.observation.observedAtSec &&
        derivation.lineage.fxSource === matchingEvidence.observation.source
        ? "verified-conversion"
        : "conversion-fx-unverified";
    }
    const datedNativeLeg = nativeLegReason === "traded-pair" || nativeLegReason === "verified-conversion";

    quotes.set(request.stablecoinId, {
      stablecoinId: request.stablecoinId,
      pegCurrency: nativeQuote.pegCurrency,
      vsCurrency: nativeQuote.vsCurrency,
      nativePrice: nativeQuote.price,
      priceUsd,
      updatedAt: datedNativeLeg && referenceObservedAtSec != null
        ? Math.min(nativeQuote.updatedAt, referenceObservedAtSec, nativeFxObservedAtSec ?? nativeQuote.updatedAt)
        : null,
      nativeObservedAtSec: nativeQuote.updatedAt,
      nativeFxObservedAtSec,
      nativeLegReason,
      referenceObservedAtSec,
      referenceSession,
      referenceAdmission,
      referencePriceUsd,
      referenceType,
    });
  }

  return quotes;
}
