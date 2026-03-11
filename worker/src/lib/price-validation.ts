import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { getCache } from "./db";

export type PriceValidationMode =
  | "primary_authoritative"
  | "fallback_enrichment"
  | "dex_observation"
  | "historical_backfill";

export type PriceReferenceType = "fresh" | "stale" | "static" | "none";

export type PegClass = "usd" | "fiat_fx" | "commodity" | "nav" | "variable" | "unknown";

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
}

export interface PriceValidationDecision {
  accepted: boolean;
  reasonCode: string;
  referenceType: PriceReferenceType;
  referencePrice: number | null;
  candidateRatio: number | null;
  boundsUsed: { min: number; max: number } | null;
}

export interface BuildPriceValidationContextInput {
  stablecoinId?: string;
  pegCurrency?: string;
  pegType?: string;
  navToken?: boolean;
  commodityOunces?: number;
}

const MAX_PRICE = 100_000;
const DEFAULT_REFERENCE_STALE_SEC = 6 * 3600;

const HARDCODED_PRICE_BOUNDS: Record<string, [min: number, max: number]> = {
  USD: [0.01, 1.19],
  EUR: [0.01, 2],
  GBP: [0.01, 2],
  CHF: [0.01, 2],
  BRL: [0.01, 2],
  REAL: [0.01, 2],
  JPY: [0.001, 0.05],
  IDR: [0.00001, 0.001],
  SGD: [0.2, 5],
  TRY: [0.005, 0.5],
  AUD: [0.2, 5],
  RUB: [0.005, 50],
  ZAR: [0.01, 0.5],
  CAD: [0.3, 2],
  CNY: [0.01, 0.5],
  CNH: [0.01, 0.5],
  PHP: [0.002, 0.1],
  MXN: [0.005, 0.2],
  UAH: [0.002, 0.15],
  ARS: [0.000001, 0.05],
  GOLD: [100, 100_000],
  SILVER: [5, 500],
};

function sanitizeRates(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

export function normalizePegTypeFromCurrency(pegCurrency: string | undefined): string | undefined {
  if (!pegCurrency || pegCurrency === "VAR" || pegCurrency === "OTHER") {
    return undefined;
  }
  if (pegCurrency === "BRL") {
    return "peggedREAL";
  }
  return `pegged${pegCurrency}`;
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

function classifyPegClass(pegCurrency: string | undefined, pegType: string | undefined, navToken: boolean): PegClass {
  if (navToken) return "nav";
  if (pegCurrency === "VAR" || pegCurrency === "OTHER") return "variable";
  if (!pegType) return "unknown";
  if (pegType.includes("USD")) return "usd";
  if (pegType.includes("GOLD") || pegType.includes("SILVER")) return "commodity";
  if (
    pegType.includes("EUR") ||
    pegType.includes("GBP") ||
    pegType.includes("CHF") ||
    pegType.includes("REAL") ||
    pegType.includes("BRL") ||
    pegType.includes("JPY") ||
    pegType.includes("IDR") ||
    pegType.includes("SGD") ||
    pegType.includes("TRY") ||
    pegType.includes("AUD") ||
    pegType.includes("RUB") ||
    pegType.includes("ZAR") ||
    pegType.includes("CAD") ||
    pegType.includes("CNY") ||
    pegType.includes("CNH") ||
    pegType.includes("PHP") ||
    pegType.includes("MXN") ||
    pegType.includes("UAH") ||
    pegType.includes("ARS")
  ) {
    return "fiat_fx";
  }
  return "unknown";
}

export function buildPriceValidationContext(
  input: BuildPriceValidationContextInput,
): PriceValidationContext {
  const trackedMeta = input.stablecoinId ? TRACKED_META_BY_ID.get(input.stablecoinId) : undefined;
  const pegCurrency = trackedMeta?.flags?.pegCurrency ?? input.pegCurrency;
  const pegType =
    normalizePegTypeFromCurrency(pegCurrency) ??
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

export async function loadPriceValidationReferences(
  db: D1Database,
  opts?: { maxAgeSec?: number; staticRates?: Record<string, number> },
): Promise<PriceValidationReferences> {
  const maxAgeSec = opts?.maxAgeSec ?? DEFAULT_REFERENCE_STALE_SEC;
  const staticRates = sanitizeRates(opts?.staticRates);

  try {
    const cached = await getCache(db, "fx-rates");
    if (!cached) {
      return {
        rates: staticRates,
        type: Object.keys(staticRates).length > 0 ? "static" : "none",
        updatedAt: null,
      };
    }

    const rates = sanitizeRates(JSON.parse(cached.value));
    if (Object.keys(rates).length === 0) {
      return {
        rates: staticRates,
        type: Object.keys(staticRates).length > 0 ? "static" : "none",
        updatedAt: cached.updatedAt,
      };
    }

    const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - cached.updatedAt);
    return {
      rates,
      type: ageSec <= maxAgeSec ? "fresh" : "stale",
      updatedAt: cached.updatedAt,
    };
  } catch {
    return {
      rates: staticRates,
      type: Object.keys(staticRates).length > 0 ? "static" : "none",
      updatedAt: null,
    };
  }
}

function getReferencePrice(
  context: PriceValidationContext,
  references: PriceValidationReferences | undefined,
): number | null {
  if (!context.pegType || !references) return null;
  const rate = references.rates[context.pegType];
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return null;
  return rate * getCommodityScale(context.pegType, context.commodityOunces);
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

export function validatePriceCandidate(
  price: number,
  context: PriceValidationContext,
  mode: PriceValidationMode,
  references?: PriceValidationReferences,
): PriceValidationDecision {
  if (!Number.isFinite(price) || price <= 0) {
    return {
      accepted: false,
      reasonCode: "non_finite_or_non_positive",
      referenceType: references?.type ?? "none",
      referencePrice: null,
      candidateRatio: null,
      boundsUsed: null,
    };
  }

  if (price >= MAX_PRICE) {
    return {
      accepted: false,
      reasonCode: "hard_cap_exceeded",
      referenceType: references?.type ?? "none",
      referencePrice: null,
      candidateRatio: null,
      boundsUsed: { min: 0, max: MAX_PRICE },
    };
  }

  if (context.pegClass === "nav") {
    return {
      accepted: true,
      reasonCode: "nav_positive_price",
      referenceType: references?.type ?? "none",
      referencePrice: getReferencePrice(context, references),
      candidateRatio: null,
      boundsUsed: { min: 0, max: MAX_PRICE },
    };
  }

  if (context.pegClass === "variable" || context.pegClass === "unknown") {
    return {
      accepted: true,
      reasonCode: "non_fixed_positive_price",
      referenceType: references?.type ?? "none",
      referencePrice: getReferencePrice(context, references),
      candidateRatio: null,
      boundsUsed: { min: 0, max: MAX_PRICE },
    };
  }

  const referencePrice = getReferencePrice(context, references);
  if (referencePrice != null && referencePrice > 0) {
    const lowerBound =
      mode === "primary_authoritative" || mode === "historical_backfill"
        ? 0
        : 0.01 * referencePrice;
    const upperBound = 2 * referencePrice;
    const candidateRatio = price / referencePrice;

    if (price >= upperBound) {
      return {
        accepted: false,
        reasonCode: "reference_upper_bound_exceeded",
        referenceType: references?.type ?? "none",
        referencePrice,
        candidateRatio,
        boundsUsed: { min: lowerBound, max: upperBound },
      };
    }

    if (lowerBound > 0 && price <= lowerBound) {
      return {
        accepted: false,
        reasonCode: "reference_lower_bound_exceeded",
        referenceType: references?.type ?? "none",
        referencePrice,
        candidateRatio,
        boundsUsed: { min: lowerBound, max: upperBound },
      };
    }

    return {
      accepted: true,
      reasonCode:
        lowerBound === 0 && candidateRatio < 0.01
          ? "authoritative_downside_allowed"
          : "within_reference_band",
      referenceType: references?.type ?? "none",
      referencePrice,
      candidateRatio,
      boundsUsed: { min: lowerBound, max: upperBound },
    };
  }

  const hardcodedBounds = getHardcodedBounds(context);
  if (hardcodedBounds) {
    const lowerBound =
      mode === "primary_authoritative" || mode === "historical_backfill"
        ? 0
        : hardcodedBounds.min;

    if (price >= hardcodedBounds.max) {
      return {
        accepted: false,
        reasonCode: "hardcoded_upper_bound_exceeded",
        referenceType: references?.type ?? "none",
        referencePrice: null,
        candidateRatio: null,
        boundsUsed: { min: lowerBound, max: hardcodedBounds.max },
      };
    }

    if (lowerBound > 0 && price <= lowerBound) {
      return {
        accepted: false,
        reasonCode: "hardcoded_lower_bound_exceeded",
        referenceType: references?.type ?? "none",
        referencePrice: null,
        candidateRatio: null,
        boundsUsed: { min: lowerBound, max: hardcodedBounds.max },
      };
    }

    return {
      accepted: true,
      reasonCode:
        lowerBound === 0
          ? "authoritative_hardcoded_downside_allowed"
          : "within_hardcoded_band",
      referenceType: references?.type ?? "none",
      referencePrice: null,
      candidateRatio: null,
      boundsUsed: { min: lowerBound, max: hardcodedBounds.max },
    };
  }

  return {
    accepted: true,
    reasonCode: "non_fixed_positive_price",
    referenceType: references?.type ?? "none",
    referencePrice: null,
    candidateRatio: null,
    boundsUsed: { min: 0, max: MAX_PRICE },
  };
}
