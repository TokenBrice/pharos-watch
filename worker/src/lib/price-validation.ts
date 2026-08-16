import { logWorkerEventArgs } from "./structured-log";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import {
  classifyPegClass,
  HARDCODED_PRICE_BOUNDS,
  type PegClass,
} from "@shared/lib/peg-price-bounds";
import { pegTypeFromCurrency } from "@shared/lib/peg-taxonomy";
import { getFxReferenceTypeFromState, loadFxRateState } from "./fx-rate-state";
import { sanitizeRecordValues } from "./normalizers";

export type PriceValidationMode =
  | "primary_authoritative"
  | "fallback_enrichment"
  | "dex_observation"
  | "historical_backfill";

export type PriceReferenceType = "fresh" | "stale" | "static" | "none";

export type { PegClass };
export { pegTypeFromCurrency as normalizePegTypeFromCurrency };

export interface PriceValidationContext {
  stablecoinId?: string;
  pegCurrency?: string;
  pegType?: string;
  pegClass: PegClass;
  navToken: boolean;
  commodityOunces?: number;
  tracked: boolean;
}

export interface PriceValidationReferences {
  rates: Record<string, number>;
  type: PriceReferenceType;
  updatedAt: number | null;
  updatedAtByPeg?: Record<string, number | null>;
  typeByPeg?: Record<string, PriceReferenceType>;
}

export interface PriceValidationDecision {
  accepted: boolean;
  reasonCode: string;
  referenceType: PriceReferenceType;
  referencePrice: number | null;
  candidateRatio: number | null;
  boundsUsed: { min: number; max: number } | null;
}

export interface DirectPriceValidationReference {
  price: number;
  type: PriceReferenceType;
}

export interface BuildPriceValidationContextInput {
  stablecoinId?: string;
  pegCurrency?: string;
  pegType?: string;
  navToken?: boolean;
  commodityOunces?: number;
}

export interface PriceReasonablenessOptions {
  navToken?: boolean;
  commodityOunces?: number;
}

const MAX_PRICE = 100_000;
const DEFAULT_REFERENCE_STALE_SEC = 6 * 3600;

export const PRICE_BOUNDS = HARDCODED_PRICE_BOUNDS;
const FIAT_FX_REFERENCE_UPPER_RATIO = PRICE_BOUNDS.USD[1];

function sanitizeRates(input: unknown): Record<string, number> {
  return sanitizeRecordValues(input, (value) => (
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
  ));
}

function getCommodityScale(pegType: string | undefined, commodityOunces: number | undefined): number {
  if (
    (pegType === "peggedGOLD" || pegType === "peggedSILVER") &&
    typeof commodityOunces === "number" &&
    Number.isFinite(commodityOunces) &&
    commodityOunces > 0
  ) {
    return commodityOunces;
  }
  return 1;
}

export function buildPriceValidationContext(
  input: BuildPriceValidationContextInput,
): PriceValidationContext {
  const trackedMeta = input.stablecoinId ? TRACKED_META_BY_ID.get(input.stablecoinId) : undefined;
  const pegCurrency = trackedMeta?.flags?.pegCurrency ?? input.pegCurrency;
  const pegType =
    pegTypeFromCurrency(pegCurrency) ??
    input.pegType;
  const navToken = trackedMeta?.flags?.navToken ?? !!input.navToken;
  const commodityOunces =
    typeof trackedMeta?.commodityOunces === "number" && Number.isFinite(trackedMeta.commodityOunces) && trackedMeta.commodityOunces > 0
      ? trackedMeta.commodityOunces
      : typeof input.commodityOunces === "number" && Number.isFinite(input.commodityOunces) && input.commodityOunces > 0
        ? input.commodityOunces
        : undefined;

  return {
    stablecoinId: input.stablecoinId,
    pegCurrency,
    pegType,
    pegClass: classifyPegClass(pegCurrency, pegType, navToken),
    navToken,
    commodityOunces,
    tracked: trackedMeta != null,
  };
}

export function buildPriceReasonablenessOptions(
  input?: { navToken?: unknown; commodityOunces?: unknown },
): PriceReasonablenessOptions {
  const commodityOunces =
    typeof input?.commodityOunces === "number" &&
    Number.isFinite(input.commodityOunces) &&
    input.commodityOunces > 0
      ? input.commodityOunces
      : undefined;

  return {
    navToken: !!input?.navToken,
    commodityOunces,
  };
}

export async function loadPriceValidationReferences(
  db: D1Database,
  opts?: { maxAgeSec?: number; staticRates?: Record<string, number> },
): Promise<PriceValidationReferences> {
  const maxAgeSec = opts?.maxAgeSec ?? DEFAULT_REFERENCE_STALE_SEC;
  const staticRates = sanitizeRates(opts?.staticRates);

  try {
    const state = await loadFxRateState(db);
    if (!state) {
      return {
        rates: staticRates,
        type: Object.keys(staticRates).length > 0 ? "static" : "none",
        updatedAt: null,
      };
    }

    const rates = sanitizeRates(state.rates);
    if (Object.keys(rates).length === 0) {
      return {
        rates: staticRates,
        type: Object.keys(staticRates).length > 0 ? "static" : "none",
        updatedAt: state.usableSyncAt,
      };
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const typeByPeg: Record<string, PriceReferenceType> = {};
    const updatedAtByPeg: Record<string, number | null> = {};
    let globalType: PriceReferenceType = "none";
    let globalUpdatedAt: number | null = null;

    for (const pegKey of Object.keys(rates)) {
      const type = getFxReferenceTypeFromState(state, pegKey, maxAgeSec, nowSec);
      typeByPeg[pegKey] = type;
      updatedAtByPeg[pegKey] = state.sourceUpdatedAtByPeg[pegKey] ?? null;
      globalUpdatedAt =
        updatedAtByPeg[pegKey] != null
          ? globalUpdatedAt == null
            ? updatedAtByPeg[pegKey]
            : Math.min(globalUpdatedAt, updatedAtByPeg[pegKey] as number)
          : globalUpdatedAt;
      if (type === "stale") {
        globalType = "stale";
      } else if (globalType !== "stale" && type === "fresh") {
        globalType = "fresh";
      } else if (globalType === "none" && type === "static") {
        globalType = "static";
      }
    }

    return {
      rates,
      type: globalType,
      updatedAt: globalUpdatedAt,
      updatedAtByPeg,
      typeByPeg,
    };
  } catch (error) {
    logWorkerEventArgs("lib", "warn", "[price-validation] Failed to load FX validation references; falling back to static references", error);
    return {
      rates: staticRates,
      type: Object.keys(staticRates).length > 0 ? "static" : "none",
      updatedAt: null,
    };
  }
}

export function getReferencePriceForContext(
  context: PriceValidationContext,
  references: PriceValidationReferences | undefined,
): number | null {
  if (!context.pegType) return null;
  if (context.pegType.includes("USD")) {
    return 1;
  }
  if (!references) return null;
  const rate = references.rates[context.pegType];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return rate * getCommodityScale(context.pegType, context.commodityOunces);
}

function getReferenceTypeForContext(
  context: PriceValidationContext,
  references: PriceValidationReferences | undefined,
): PriceReferenceType {
  if (!references) return "none";
  if (context.pegType && references.typeByPeg?.[context.pegType]) {
    return references.typeByPeg[context.pegType] ?? references.type;
  }
  return references.type;
}

function getHardcodedBounds(context: PriceValidationContext): { min: number; max: number } | null {
  if (!context.pegType) return null;

  if (context.pegType.includes("USD")) {
    const [min, max] = HARDCODED_PRICE_BOUNDS.USD;
    return { min, max };
  }

  for (const [key, [min, max]] of Object.entries(HARDCODED_PRICE_BOUNDS)) {
    if (key === "USD") continue;
    if (context.pegType.includes(key)) {
      const scale = (key === "GOLD" || key === "SILVER")
        ? getCommodityScale(context.pegType, context.commodityOunces)
        : 1;
      return { min: min * scale, max: max * scale };
    }
  }

  return null;
}

function isFixedPegContext(context: PriceValidationContext): boolean {
  return context.pegClass === "usd" || context.pegClass === "fiat_fx" || context.pegClass === "commodity";
}

function getReferenceUpperBound(context: PriceValidationContext, referencePrice: number): number {
  if (context.pegClass === "usd") return PRICE_BOUNDS.USD[1];
  if (context.pegClass === "fiat_fx") return FIAT_FX_REFERENCE_UPPER_RATIO * referencePrice;
  return 2 * referencePrice;
}

export function isSevereFixedPegDownside(
  price: number,
  context: PriceValidationContext,
  references?: PriceValidationReferences,
  downsideRatio = 0.5,
): boolean {
  if (!Number.isFinite(price) || price <= 0 || !isFixedPegContext(context)) {
    return false;
  }

  const referencePrice = getReferencePriceForContext(context, references);
  if (referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return false;
  }

  return (price / referencePrice) < downsideRatio;
}

function isAuthoritativeDownsideMode(mode: PriceValidationMode): boolean {
  return mode === "primary_authoritative" || mode === "historical_backfill";
}

function buildDecision(input: {
  accepted: boolean;
  reasonCode: string;
  referenceType: PriceReferenceType;
  referencePrice: number | null;
  candidateRatio: number | null;
  boundsUsed: { min: number; max: number } | null;
}): PriceValidationDecision {
  return input;
}

function validateCandidatePreamble(
  price: number,
  context: PriceValidationContext,
  referenceType: PriceReferenceType,
  referencePrice: number | null,
): PriceValidationDecision | null {
  if (!Number.isFinite(price) || price <= 0) {
    return buildDecision({
      accepted: false,
      reasonCode: "non_finite_or_non_positive",
      referenceType,
      referencePrice,
      candidateRatio: null,
      boundsUsed: null,
    });
  }

  if (price >= MAX_PRICE) {
    return buildDecision({
      accepted: false,
      reasonCode: "hard_cap_exceeded",
      referenceType,
      referencePrice,
      candidateRatio: null,
      boundsUsed: { min: 0, max: MAX_PRICE },
    });
  }

  if (context.pegClass === "nav") {
    return buildDecision({
      accepted: true,
      reasonCode: "nav_positive_price",
      referenceType,
      referencePrice,
      candidateRatio: null,
      boundsUsed: { min: 0, max: MAX_PRICE },
    });
  }

  if (context.pegClass === "variable" || context.pegClass === "unknown") {
    return buildDecision({
      accepted: true,
      reasonCode: "non_fixed_positive_price",
      referenceType,
      referencePrice,
      candidateRatio: null,
      boundsUsed: { min: 0, max: MAX_PRICE },
    });
  }

  return null;
}

function evaluateReferenceBand(
  price: number,
  context: PriceValidationContext,
  mode: PriceValidationMode,
  referenceType: PriceReferenceType,
  referencePrice: number | null,
): PriceValidationDecision | null {
  if (referencePrice == null || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return null;
  }

  const lowerBound = isAuthoritativeDownsideMode(mode) ? 0 : 0.01 * referencePrice;
  const upperBound = getReferenceUpperBound(context, referencePrice);
  const candidateRatio = price / referencePrice;

  if (price >= upperBound) {
    return buildDecision({
      accepted: false,
      reasonCode: "reference_upper_bound_exceeded",
      referenceType,
      referencePrice,
      candidateRatio,
      boundsUsed: { min: lowerBound, max: upperBound },
    });
  }

  if (lowerBound > 0 && price <= lowerBound) {
    return buildDecision({
      accepted: false,
      reasonCode: "reference_lower_bound_exceeded",
      referenceType,
      referencePrice,
      candidateRatio,
      boundsUsed: { min: lowerBound, max: upperBound },
    });
  }

  return buildDecision({
    accepted: true,
    reasonCode:
      lowerBound === 0 && candidateRatio < 0.01
        ? "authoritative_downside_allowed"
        : "within_reference_band",
    referenceType,
    referencePrice,
    candidateRatio,
    boundsUsed: { min: lowerBound, max: upperBound },
  });
}

function evaluateHardcodedBand(
  price: number,
  mode: PriceValidationMode,
  referenceType: PriceReferenceType,
  hardcodedBounds: { min: number; max: number } | null,
): PriceValidationDecision | null {
  if (!hardcodedBounds) {
    return null;
  }

  const lowerBound = isAuthoritativeDownsideMode(mode) ? 0 : hardcodedBounds.min;
  if (price >= hardcodedBounds.max) {
    return buildDecision({
      accepted: false,
      reasonCode: "hardcoded_upper_bound_exceeded",
      referenceType,
      referencePrice: null,
      candidateRatio: null,
      boundsUsed: { min: lowerBound, max: hardcodedBounds.max },
    });
  }

  if (lowerBound > 0 && price <= lowerBound) {
    return buildDecision({
      accepted: false,
      reasonCode: "hardcoded_lower_bound_exceeded",
      referenceType,
      referencePrice: null,
      candidateRatio: null,
      boundsUsed: { min: lowerBound, max: hardcodedBounds.max },
    });
  }

  return buildDecision({
    accepted: true,
    reasonCode:
      lowerBound === 0
        ? "authoritative_hardcoded_downside_allowed"
        : "within_hardcoded_band",
    referenceType,
    referencePrice: null,
    candidateRatio: null,
    boundsUsed: { min: lowerBound, max: hardcodedBounds.max },
  });
}

export function validatePriceCandidate(
  price: number,
  context: PriceValidationContext,
  mode: PriceValidationMode,
  references?: PriceValidationReferences,
): PriceValidationDecision {
  const referenceType = getReferenceTypeForContext(context, references);
  const referencePrice = getReferencePriceForContext(context, references);
  const preamble = validateCandidatePreamble(price, context, referenceType, referencePrice);
  if (preamble) {
    return preamble;
  }

  const referenceDecision = evaluateReferenceBand(price, context, mode, referenceType, referencePrice);
  if (referenceDecision) {
    return referenceDecision;
  }

  const hardcodedDecision = evaluateHardcodedBand(price, mode, referenceType, getHardcodedBounds(context));
  if (hardcodedDecision) {
    return hardcodedDecision;
  }

  return buildDecision({
    accepted: true,
    reasonCode: "non_fixed_positive_price",
    referenceType,
    referencePrice: null,
    candidateRatio: null,
    boundsUsed: { min: 0, max: MAX_PRICE },
  });
}

export function validatePriceCandidateAgainstReference(
  price: number,
  context: PriceValidationContext,
  mode: PriceValidationMode,
  reference: DirectPriceValidationReference | null,
): PriceValidationDecision {
  const referenceType = reference?.type ?? "none";
  const referencePrice = reference?.price ?? null;
  const preamble = validateCandidatePreamble(price, context, referenceType, referencePrice);
  if (preamble) {
    return preamble;
  }

  const referenceDecision = evaluateReferenceBand(price, context, mode, referenceType, referencePrice);
  if (referenceDecision) {
    return referenceDecision;
  }

  return validatePriceCandidate(price, context, mode);
}

export function isReasonablePrice(
  price: number,
  pegType: string | undefined,
  fxRates?: Record<string, number>,
  opts?: PriceReasonablenessOptions,
): boolean {
  if (!Number.isFinite(price) || price <= 0 || price >= MAX_PRICE) return false;

  const context = buildPriceValidationContext({
    pegType,
    navToken: opts?.navToken,
    commodityOunces: opts?.commodityOunces,
  });

  if (context.pegClass === "nav") return true;
  if (!context.pegType) return true;

  if (context.pegType.includes("USD")) {
    const [min, max] = PRICE_BOUNDS.USD;
    return price > min && price < max;
  }

  const referencePrice = getReferencePriceForContext(
    context,
    fxRates
      ? {
          rates: fxRates,
          type: "fresh",
          updatedAt: null,
          updatedAtByPeg: Object.fromEntries(Object.keys(fxRates).map((pegKey) => [pegKey, null])),
          typeByPeg: Object.fromEntries(Object.keys(fxRates).map((pegKey) => [pegKey, "fresh"])),
        }
      : undefined,
  );
  if (referencePrice != null && referencePrice > 0) {
    return price > 0.01 * referencePrice && price < getReferenceUpperBound(context, referencePrice);
  }

  const hardcodedBounds = getHardcodedBounds(context);
  if (hardcodedBounds) {
    return price > hardcodedBounds.min && price < hardcodedBounds.max;
  }

  return price > 0 && price < MAX_PRICE;
}
