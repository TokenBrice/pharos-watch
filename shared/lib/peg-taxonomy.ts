import { PEG_CURRENCY_VALUES, type PegCurrency } from "../types/core";
import { PEG_METADATA } from "./classification/pegs";

export type PegClass = "usd" | "fiat_fx" | "commodity" | "nav" | "variable" | "unknown";
export type PegPriceBounds = readonly [min: number, max: number];

interface PegTaxonomyFacts {
  symbol: string;
  pegClass: Exclude<PegClass, "nav" | "unknown">;
  canonicalPegType: string | null;
  currencyAliases?: readonly string[];
  pegTypeAliases?: readonly string[];
  hardcodedPriceBounds?: PegPriceBounds;
  fxRateBounds?: PegPriceBounds;
  nativePriceUsesUsdSymbol?: boolean;
}

export interface PegTaxonomyEntry extends PegTaxonomyFacts {
  currency: PegCurrency;
  heroChipLabel: `${PegCurrency}-Pegged`;
  presentation: (typeof PEG_METADATA)[PegCurrency];
}

const PEG_TAXONOMY_FACTS = {
  USD: { symbol: "$", pegClass: "usd", canonicalPegType: "peggedUSD", hardcodedPriceBounds: [0.01, 1.19], nativePriceUsesUsdSymbol: true },
  EUR: { symbol: "€", pegClass: "fiat_fx", canonicalPegType: "peggedEUR", hardcodedPriceBounds: [0.01, 2], fxRateBounds: [0.5, 2.5] },
  GBP: { symbol: "£", pegClass: "fiat_fx", canonicalPegType: "peggedGBP", hardcodedPriceBounds: [0.01, 2], fxRateBounds: [0.5, 3] },
  CHF: { symbol: "₣", pegClass: "fiat_fx", canonicalPegType: "peggedCHF", hardcodedPriceBounds: [0.01, 2], fxRateBounds: [0.4, 2.5] },
  BRL: { symbol: "R$", pegClass: "fiat_fx", canonicalPegType: "peggedREAL", currencyAliases: ["REAL"], pegTypeAliases: ["peggedBRL"], hardcodedPriceBounds: [0.01, 2], fxRateBounds: [0.05, 0.6] },
  RUB: { symbol: "₽", pegClass: "fiat_fx", canonicalPegType: "peggedRUB", hardcodedPriceBounds: [0.005, 0.5], fxRateBounds: [0.003, 0.1] },
  JPY: { symbol: "¥", pegClass: "fiat_fx", canonicalPegType: "peggedJPY", hardcodedPriceBounds: [0.001, 0.05], fxRateBounds: [0.003, 0.03] },
  KRW: { symbol: "₩", pegClass: "fiat_fx", canonicalPegType: "peggedKRW", hardcodedPriceBounds: [0.0005, 0.001], fxRateBounds: [0.0005, 0.001] },
  IDR: { symbol: "Rp", pegClass: "fiat_fx", canonicalPegType: "peggedIDR", hardcodedPriceBounds: [0.00001, 0.001], fxRateBounds: [0.00003, 0.0003] },
  INR: { symbol: "₹", pegClass: "fiat_fx", canonicalPegType: "peggedINR", hardcodedPriceBounds: [0.001, 0.1], fxRateBounds: [0.005, 0.05] },
  MYR: { symbol: "RM", pegClass: "fiat_fx", canonicalPegType: "peggedMYR", hardcodedPriceBounds: [0.18, 0.3], fxRateBounds: [0.18, 0.3] },
  SGD: { symbol: "S$", pegClass: "fiat_fx", canonicalPegType: "peggedSGD", hardcodedPriceBounds: [0.2, 5], fxRateBounds: [0.3, 1.5] },
  HKD: { symbol: "HK$", pegClass: "fiat_fx", canonicalPegType: "peggedHKD", hardcodedPriceBounds: [0.01, 0.5], fxRateBounds: [0.05, 0.25] },
  TRY: { symbol: "₺", pegClass: "fiat_fx", canonicalPegType: "peggedTRY", hardcodedPriceBounds: [0.005, 0.5], fxRateBounds: [0.01, 0.2] },
  AUD: { symbol: "A$", pegClass: "fiat_fx", canonicalPegType: "peggedAUD", hardcodedPriceBounds: [0.2, 5], fxRateBounds: [0.3, 1.5] },
  ZAR: { symbol: "R", pegClass: "fiat_fx", canonicalPegType: "peggedZAR", hardcodedPriceBounds: [0.01, 0.5], fxRateBounds: [0.02, 0.2] },
  CAD: { symbol: "C$", pegClass: "fiat_fx", canonicalPegType: "peggedCAD", hardcodedPriceBounds: [0.3, 2], fxRateBounds: [0.4, 1.5] },
  CNY: { symbol: "¥", pegClass: "fiat_fx", canonicalPegType: "peggedCNY", hardcodedPriceBounds: [0.01, 0.5], fxRateBounds: [0.05, 0.4] },
  CNH: { symbol: "¥", pegClass: "fiat_fx", canonicalPegType: "peggedCNH", hardcodedPriceBounds: [0.01, 0.5], fxRateBounds: [0.05, 0.4] },
  PHP: { symbol: "₱", pegClass: "fiat_fx", canonicalPegType: "peggedPHP", hardcodedPriceBounds: [0.002, 0.1], fxRateBounds: [0.01, 0.06] },
  MXN: { symbol: "MX$", pegClass: "fiat_fx", canonicalPegType: "peggedMXN", hardcodedPriceBounds: [0.005, 0.2], fxRateBounds: [0.02, 0.15] },
  VND: { symbol: "₫", pegClass: "fiat_fx", canonicalPegType: "peggedVND", hardcodedPriceBounds: [0.00002, 0.00006], fxRateBounds: [0.00002, 0.00006] },
  UAH: { symbol: "₴", pegClass: "fiat_fx", canonicalPegType: "peggedUAH", hardcodedPriceBounds: [0.002, 0.15], fxRateBounds: [0.01, 0.1] },
  ARS: { symbol: "AR$", pegClass: "fiat_fx", canonicalPegType: "peggedARS", hardcodedPriceBounds: [0.000001, 0.05], fxRateBounds: [0.0001, 0.01] },
  KGS: { symbol: "som", pegClass: "fiat_fx", canonicalPegType: "peggedKGS", hardcodedPriceBounds: [0.005, 0.05], fxRateBounds: [0.005, 0.05] },
  NGN: { symbol: "₦", pegClass: "fiat_fx", canonicalPegType: "peggedNGN", hardcodedPriceBounds: [0.0002, 0.005], fxRateBounds: [0.0002, 0.005] },
  XOF: { symbol: "CFA ", pegClass: "fiat_fx", canonicalPegType: "peggedXOF", hardcodedPriceBounds: [0.001, 0.005], fxRateBounds: [0.001, 0.005] },
  COP: { symbol: "COL$", pegClass: "fiat_fx", canonicalPegType: "peggedCOP", hardcodedPriceBounds: [0.00015, 0.0006], fxRateBounds: [0.00015, 0.0006] },
  CLP: { symbol: "CL$", pegClass: "fiat_fx", canonicalPegType: "peggedCLP", hardcodedPriceBounds: [0.0007, 0.002], fxRateBounds: [0.0007, 0.002] },
  GHS: { symbol: "₵", pegClass: "fiat_fx", canonicalPegType: "peggedGHS", hardcodedPriceBounds: [0.02, 0.25], fxRateBounds: [0.02, 0.25] },
  KES: { symbol: "KSh", pegClass: "fiat_fx", canonicalPegType: "peggedKES", hardcodedPriceBounds: [0.005, 0.012], fxRateBounds: [0.005, 0.012] },
  PEN: { symbol: "S/", pegClass: "fiat_fx", canonicalPegType: "peggedPEN", hardcodedPriceBounds: [0.2, 0.4], fxRateBounds: [0.2, 0.4] },
  GOLD: { symbol: "$", pegClass: "commodity", canonicalPegType: "peggedGOLD", hardcodedPriceBounds: [100, 100_000], fxRateBounds: [500, 10_000], nativePriceUsesUsdSymbol: true },
  SILVER: { symbol: "$", pegClass: "commodity", canonicalPegType: "peggedSILVER", hardcodedPriceBounds: [5, 500], fxRateBounds: [5, 500], nativePriceUsesUsdSymbol: true },
  VAR: { symbol: "$", pegClass: "variable", canonicalPegType: null, nativePriceUsesUsdSymbol: true },
  OTHER: { symbol: "$", pegClass: "variable", canonicalPegType: null, nativePriceUsesUsdSymbol: true },
} as const satisfies Record<PegCurrency, PegTaxonomyFacts>;

export const PEG_TAXONOMY = Object.fromEntries(
  PEG_CURRENCY_VALUES.map((currency) => [
    currency,
    {
      currency,
      ...PEG_TAXONOMY_FACTS[currency],
      heroChipLabel: `${currency}-Pegged`,
      presentation: PEG_METADATA[currency],
    },
  ]),
) as unknown as Readonly<Record<PegCurrency, PegTaxonomyEntry>>;

const PEG_BY_CURRENCY = new Map<string, PegTaxonomyEntry>();
const PEG_BY_TYPE = new Map<string, PegTaxonomyEntry>();
for (const entry of Object.values(PEG_TAXONOMY)) {
  PEG_BY_CURRENCY.set(entry.currency, entry);
  for (const alias of entry.currencyAliases ?? []) PEG_BY_CURRENCY.set(alias, entry);
  if (entry.canonicalPegType) PEG_BY_TYPE.set(entry.canonicalPegType, entry);
  for (const alias of entry.pegTypeAliases ?? []) PEG_BY_TYPE.set(alias, entry);
}

export function getPegTaxonomyByCurrency(currency: string | undefined): PegTaxonomyEntry | undefined {
  if (!currency) return undefined;
  return PEG_BY_CURRENCY.get(currency.trim().toUpperCase());
}

export function getPegTaxonomyByType(pegType: string | undefined): PegTaxonomyEntry | undefined {
  if (!pegType) return undefined;
  return PEG_BY_TYPE.get(pegType.trim());
}

export function normalizePegTypeAlias(pegType: string): string {
  return getPegTaxonomyByType(pegType)?.canonicalPegType ?? pegType;
}

export function pegTypeFromCurrency(currency: string | undefined): string | undefined {
  return getPegTaxonomyByCurrency(currency)?.canonicalPegType ?? undefined;
}

export const PEG_CURRENCY_SYMBOLS = Object.fromEntries(
  Object.values(PEG_TAXONOMY).map((entry) => [entry.currency, entry.symbol]),
) as Record<PegCurrency, string>;

export const PEG_HERO_CHIP_LABELS = Object.fromEntries(
  Object.values(PEG_TAXONOMY).map((entry) => [entry.currency, entry.heroChipLabel]),
) as Record<PegCurrency, `${PegCurrency}-Pegged`>;

export const PEG_HARDCODED_PRICE_BOUNDS = Object.fromEntries(
  Object.values(PEG_TAXONOMY).flatMap((entry) => {
    // Bind before the nested closure: the `if` guard below does not narrow
    // `entry.hardcodedPriceBounds` inside the `.map()` callback.
    const bounds = entry.hardcodedPriceBounds;
    if (!bounds) return [];
    return [
      [entry.currency, [...bounds]],
      ...(entry.currencyAliases ?? []).map((alias) => [alias, [...bounds]]),
    ];
  }),
) as Record<string, [number, number]>;

export const PEG_FX_RATE_BOUNDS = Object.fromEntries(
  Object.values(PEG_TAXONOMY).flatMap((entry) => entry.canonicalPegType && entry.fxRateBounds
    ? [[entry.canonicalPegType, [...entry.fxRateBounds]]]
    : []),
) as Record<string, [number, number]>;
