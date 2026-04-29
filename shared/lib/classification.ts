/**
 * Single-source-of-truth for classification labels, badge colors, and style maps.
 *
 * All consumer components should import from here instead of defining local copies.
 * Tailwind class strings are always complete static literals (never constructed dynamically).
 */

import type {
  GovernanceType,
  BackingType,
  PegCurrency,
  StablecoinMeta,
  BlacklistEventType,
  BlacklistStablecoin,
  FilterTag,
  YieldType,
} from "../types";
import { ACTIVE_STABLECOINS } from "./stablecoins";

interface BadgeStyle {
  label: string;
  cls: string;
}

interface PegChartColor {
  label: string;
  textColor: string;
  bgColor: string;
  hex: string;
}

interface PegMetadata {
  label: string;
  shortLabel: string;
  filterTag: FilterTag;
  filterLabel: string;
  badge: BadgeStyle;
  chart?: PegChartColor;
}

// ---------------------------------------------------------------------------
// Governance (Type) labels
// ---------------------------------------------------------------------------

/** Full labels used in metadata, descriptions, and structured data. */
export const GOVERNANCE_LABELS: Record<GovernanceType, string> = {
  centralized: "Centralized (CeFi)",
  "centralized-dependent": "CeFi-Dependent",
  decentralized: "Decentralized (DeFi)",
};

/** Short labels used in table badges, stat cards, and filter options. */
export const GOVERNANCE_LABELS_SHORT: Record<GovernanceType, string> = {
  centralized: "CeFi",
  "centralized-dependent": "CeFi-Dep",
  decentralized: "DeFi",
};

// ---------------------------------------------------------------------------
// Filter option tuples — used by heatmap and depeg filter UIs
// ---------------------------------------------------------------------------

export const GOVERNANCE_FILTER_OPTIONS: { value: GovernanceType | "all"; label: string }[] = [
  { value: "all", label: "All Types" },
  { value: "centralized", label: GOVERNANCE_LABELS_SHORT.centralized },
  { value: "centralized-dependent", label: GOVERNANCE_LABELS_SHORT["centralized-dependent"] },
  { value: "decentralized", label: GOVERNANCE_LABELS_SHORT.decentralized },
];

// ---------------------------------------------------------------------------
// Backing labels
// ---------------------------------------------------------------------------

/** Full labels used in metadata and descriptions. */
export const BACKING_LABELS: Record<BackingType, string> = {
  "rwa-backed": "Real-World Asset Backed",
  "crypto-backed": "Crypto-Collateralized",
  algorithmic: "Algorithmic",
};

/** Short labels used in table badge text. */
export const BACKING_LABELS_SHORT: Record<BackingType, string> = {
  "rwa-backed": "RWA",
  "crypto-backed": "Crypto",
  algorithmic: "Algo",
};

export function getBackingLabelShort(value: string): string {
  if (value in BACKING_LABELS_SHORT) {
    return BACKING_LABELS_SHORT[value as BackingType];
  }
  if (value === "fiat" || value === "fiat-backed") return "Fiat";
  if (value === "crypto") return "Crypto";
  if (value === "rwa") return "RWA";
  return value;
}

export function getGovernanceLabelShort(value: string): string {
  if (value in GOVERNANCE_LABELS_SHORT) {
    return GOVERNANCE_LABELS_SHORT[value as GovernanceType];
  }
  return value;
}

// ---------------------------------------------------------------------------
// Peg currency labels
// ---------------------------------------------------------------------------

export const PEG_METADATA = {
  USD: {
    label: "the US Dollar",
    shortLabel: "US Dollar",
    filterTag: "usd-peg",
    filterLabel: "USD",
    badge: {
      label: "USD Peg",
      cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    },
  },
  EUR: {
    label: "the Euro",
    shortLabel: "Euro",
    filterTag: "eur-peg",
    filterLabel: "EUR",
    badge: {
      label: "EUR Peg",
      cls: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20",
    },
    chart: { label: "Euro", textColor: "text-violet-700 dark:text-violet-400", bgColor: "bg-violet-500", hex: "#8b5cf6" },
  },
  GBP: {
    label: "the British Pound",
    shortLabel: "British Pound",
    filterTag: "gbp-peg",
    filterLabel: "GBP",
    badge: {
      label: "GBP Peg",
      cls: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20",
    },
    chart: { label: "Pound", textColor: "text-cyan-700 dark:text-cyan-400", bgColor: "bg-cyan-500", hex: "#06b6d4" },
  },
  CHF: {
    label: "the Swiss Franc",
    shortLabel: "Swiss Franc",
    filterTag: "chf-peg",
    filterLabel: "CHF",
    badge: {
      label: "CHF Peg",
      cls: "bg-pink-500/10 text-pink-700 dark:text-pink-400 border-pink-500/20",
    },
    chart: { label: "Franc", textColor: "text-pink-700 dark:text-pink-400", bgColor: "bg-pink-500", hex: "#ec4899" },
  },
  BRL: {
    label: "the Brazilian Real",
    shortLabel: "Brazilian Real",
    filterTag: "brl-peg",
    filterLabel: "BRL",
    badge: {
      label: "BRL Peg",
      cls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
    },
    chart: { label: "Real", textColor: "text-orange-700 dark:text-orange-400", bgColor: "bg-orange-500", hex: "#f97316" },
  },
  RUB: {
    label: "the Russian Ruble",
    shortLabel: "Russian Ruble",
    filterTag: "rub-peg",
    filterLabel: "RUB",
    badge: {
      label: "RUB Peg",
      cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
    },
    chart: { label: "Ruble", textColor: "text-red-700 dark:text-red-400", bgColor: "bg-red-500", hex: "#ef4444" },
  },
  JPY: {
    label: "the Japanese Yen",
    shortLabel: "Japanese Yen",
    filterTag: "jpy-peg",
    filterLabel: "JPY",
    badge: {
      label: "JPY Peg",
      cls: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20",
    },
    chart: { label: "Yen", textColor: "text-rose-700 dark:text-rose-400", bgColor: "bg-rose-500", hex: "#f43f5e" },
  },
  KRW: {
    label: "the Korean Won",
    shortLabel: "Korean Won",
    filterTag: "krw-peg",
    filterLabel: "KRW",
    badge: {
      label: "KRW Peg",
      cls: "bg-red-600/10 text-red-700 dark:text-red-400 border-red-600/20",
    },
    chart: { label: "Won", textColor: "text-red-700 dark:text-red-400", bgColor: "bg-red-600", hex: "#dc2626" },
  },
  IDR: {
    label: "the Indonesian Rupiah",
    shortLabel: "Indonesian Rupiah",
    filterTag: "idr-peg",
    filterLabel: "IDR",
    badge: {
      label: "IDR Peg",
      cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    },
    chart: { label: "Rupiah", textColor: "text-amber-700 dark:text-amber-400", bgColor: "bg-amber-500", hex: "#f59e0b" },
  },
  MYR: {
    label: "the Malaysian Ringgit",
    shortLabel: "Malaysian Ringgit",
    filterTag: "myr-peg",
    filterLabel: "MYR",
    badge: {
      label: "MYR Peg",
      cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
    },
    chart: { label: "Ringgit", textColor: "text-sky-700 dark:text-sky-400", bgColor: "bg-sky-500", hex: "#0ea5e9" },
  },
  SGD: {
    label: "the Singapore Dollar",
    shortLabel: "Singapore Dollar",
    filterTag: "sgd-peg",
    filterLabel: "SGD",
    badge: {
      label: "SGD Peg",
      cls: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20",
    },
    chart: { label: "SGD", textColor: "text-teal-700 dark:text-teal-400", bgColor: "bg-teal-500", hex: "#14b8a6" },
  },
  TRY: {
    label: "the Turkish Lira",
    shortLabel: "Turkish Lira",
    filterTag: "try-peg",
    filterLabel: "TRY",
    badge: {
      label: "TRY Peg",
      cls: "bg-lime-500/10 text-lime-700 dark:text-lime-400 border-lime-500/20",
    },
    chart: { label: "Lira", textColor: "text-lime-700 dark:text-lime-400", bgColor: "bg-lime-500", hex: "#84cc16" },
  },
  AUD: {
    label: "the Australian Dollar",
    shortLabel: "Australian Dollar",
    filterTag: "aud-peg",
    filterLabel: "AUD",
    badge: {
      label: "AUD Peg",
      cls: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20",
    },
    chart: { label: "AUD", textColor: "text-indigo-700 dark:text-indigo-400", bgColor: "bg-indigo-500", hex: "#6366f1" },
  },
  ZAR: {
    label: "the South African Rand",
    shortLabel: "South African Rand",
    filterTag: "zar-peg",
    filterLabel: "ZAR",
    badge: {
      label: "ZAR Peg",
      cls: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/20",
    },
    chart: {
      label: "Rand",
      textColor: "text-fuchsia-700 dark:text-fuchsia-400",
      bgColor: "bg-fuchsia-500",
      hex: "#d946ef",
    },
  },
  CAD: {
    label: "the Canadian Dollar",
    shortLabel: "Canadian Dollar",
    filterTag: "cad-peg",
    filterLabel: "CAD",
    badge: {
      label: "CAD Peg",
      cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
    },
    chart: { label: "CAD", textColor: "text-blue-700 dark:text-blue-400", bgColor: "bg-blue-500", hex: "#3b82f6" },
  },
  CNY: {
    label: "the Chinese Yuan",
    shortLabel: "Chinese Yuan",
    filterTag: "cny-peg",
    filterLabel: "CNY",
    badge: {
      label: "CNY Peg",
      cls: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
    },
    chart: { label: "Yuan", textColor: "text-purple-700 dark:text-purple-400", bgColor: "bg-purple-500", hex: "#a855f7" },
  },
  CNH: {
    label: "the Offshore Yuan",
    shortLabel: "Offshore Yuan",
    filterTag: "cnh-peg",
    filterLabel: "CNH",
    badge: {
      label: "CNH Peg",
      cls: "bg-purple-600/10 text-purple-800 dark:text-purple-300 border-purple-600/20",
    },
    chart: { label: "CNH", textColor: "text-purple-800 dark:text-purple-300", bgColor: "bg-purple-600", hex: "#9333ea" },
  },
  PHP: {
    label: "the Philippine Peso",
    shortLabel: "Philippine Peso",
    filterTag: "php-peg",
    filterLabel: "PHP",
    badge: {
      label: "PHP Peg",
      cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    },
    chart: { label: "PHP", textColor: "text-emerald-700 dark:text-emerald-400", bgColor: "bg-emerald-500", hex: "#10b981" },
  },
  MXN: {
    label: "the Mexican Peso",
    shortLabel: "Mexican Peso",
    filterTag: "mxn-peg",
    filterLabel: "MXN",
    badge: {
      label: "MXN Peg",
      cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
    },
    chart: { label: "MXN", textColor: "text-green-700 dark:text-green-400", bgColor: "bg-green-500", hex: "#22c55e" },
  },
  UAH: {
    label: "the Ukrainian Hryvnia",
    shortLabel: "Ukrainian Hryvnia",
    filterTag: "uah-peg",
    filterLabel: "UAH",
    badge: { label: "UAH Peg", cls: "bg-sky-600/10 text-sky-600 border-sky-600/20" },
    chart: { label: "UAH", textColor: "text-sky-600", bgColor: "bg-sky-600", hex: "#0284c7" },
  },
  ARS: {
    label: "the Argentine Peso",
    shortLabel: "Argentine Peso",
    filterTag: "ars-peg",
    filterLabel: "ARS",
    badge: {
      label: "ARS Peg",
      cls: "bg-stone-500/10 text-stone-700 dark:text-stone-400 border-stone-500/20",
    },
    chart: { label: "ARS", textColor: "text-stone-700 dark:text-stone-400", bgColor: "bg-stone-500", hex: "#78716c" },
  },
  GOLD: {
    label: "Gold",
    shortLabel: "Gold",
    filterTag: "gold-peg",
    filterLabel: "Gold",
    badge: {
      label: "Gold Peg",
      cls: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
    },
    chart: { label: "Gold", textColor: "text-yellow-700 dark:text-yellow-400", bgColor: "bg-yellow-500", hex: "#eab308" },
  },
  SILVER: {
    label: "Silver",
    shortLabel: "Silver",
    filterTag: "silver-peg",
    filterLabel: "Silver",
    badge: {
      label: "Silver Peg",
      cls: "bg-gray-400/10 text-gray-700 dark:text-gray-400 border-gray-400/20",
    },
    chart: { label: "Silver", textColor: "text-gray-700 dark:text-gray-400", bgColor: "bg-gray-400", hex: "#9ca3af" },
  },
  VAR: {
    label: "CPI",
    shortLabel: "CPI",
    filterTag: "var-peg",
    filterLabel: "CPI",
    badge: {
      label: "CPI Peg",
      cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20",
    },
    chart: { label: "CPI", textColor: "text-slate-700 dark:text-slate-400", bgColor: "bg-slate-500", hex: "#64748b" },
  },
  OTHER: {
    label: "Other",
    shortLabel: "Other",
    filterTag: "other-peg",
    filterLabel: "Other",
    badge: {
      label: "Other Peg",
      cls: "bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20",
    },
    chart: { label: "Other", textColor: "text-slate-700 dark:text-slate-400", bgColor: "bg-slate-500", hex: "#64748b" },
  },
} as const satisfies Record<PegCurrency, PegMetadata>;

export type PegCurrencyFilterTag = (typeof PEG_METADATA)[PegCurrency]["filterTag"];

function mapPegMetadata<T>(select: (metadata: PegMetadata) => T): Record<PegCurrency, T> {
  return Object.fromEntries(
    Object.entries(PEG_METADATA).map(([peg, metadata]) => [peg, select(metadata)]),
  ) as Record<PegCurrency, T>;
}

/** Full labels with article, for prose descriptions. */
export const PEG_LABELS = mapPegMetadata((metadata) => metadata.label);

/** Number of distinct peg currencies actually tracked (with at least one stablecoin). */
export const PEG_CURRENCY_COUNT = new Set(ACTIVE_STABLECOINS.map((s) => s.flags.pegCurrency)).size;

/** Labels without article, for metadata and keywords. */
export const PEG_LABELS_SHORT = mapPegMetadata((metadata) => metadata.shortLabel);

export const PEG_FILTER_TAG_LABELS = Object.fromEntries(
  Object.values(PEG_METADATA).map((metadata) => [metadata.filterTag, metadata.filterLabel]),
) as Record<PegCurrencyFilterTag, string>;

export const PEG_FILTER_OPTIONS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All Pegs" },
  { value: "USD", label: PEG_METADATA.USD.filterLabel },
  { value: "EUR", label: PEG_METADATA.EUR.filterLabel },
  { value: "GOLD", label: PEG_METADATA.GOLD.filterLabel },
];

// ---------------------------------------------------------------------------
// Badge color classes (for table/detail badges with bg + text + border)
// ---------------------------------------------------------------------------

/** Governance badge colors used in the main table. */
export const GOVERNANCE_COLORS: Record<GovernanceType, string> = {
  centralized: "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-500/20",
  "centralized-dependent": "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  decentralized: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
};

/** Backing badge colors used in the main table. */
export const BACKING_COLORS: Record<BackingType, string> = {
  "rwa-backed": "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  "crypto-backed": "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
  algorithmic: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
};

// ---------------------------------------------------------------------------
// Combined label+class style maps (for detail page pill badges)
// ---------------------------------------------------------------------------

type ProofOfReservesType = NonNullable<StablecoinMeta["proofOfReserves"]>["type"];

/** Governance badge styles for the detail page. */
export const GOVERNANCE_BADGE_STYLES: Record<GovernanceType, BadgeStyle> = {
  centralized: {
    label: "Centralized",
    cls: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
  },
  "centralized-dependent": {
    label: "CeFi-Dependent",
    cls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  },
  decentralized: {
    label: "Decentralized",
    cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  },
};

/** Backing badge styles for the detail page. */
export const BACKING_BADGE_STYLES: Record<BackingType, BadgeStyle> = {
  "rwa-backed": { label: "RWA-Backed", cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
  "crypto-backed": {
    label: "Crypto-Backed",
    cls: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20",
  },
  algorithmic: {
    label: "Algorithmic",
    cls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  },
};

/** Peg currency badge styles for the detail page. */
export const PEG_BADGE_STYLES = mapPegMetadata((metadata) => metadata.badge);

/** Proof-of-reserves badge styles for the detail page. */
export const POR_BADGE_STYLES: Record<ProofOfReservesType, BadgeStyle> = {
  "independent-audit": {
    label: "Independent Audit",
    cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20",
  },
  "real-time": {
    label: "Real-Time PoR",
    cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
  },
  "self-reported": {
    label: "Self-Reported PoR",
    cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
  },
};

// ---------------------------------------------------------------------------
// Governance chart/stat card colors (text + bg pairs for bar segments & legends)
// ---------------------------------------------------------------------------

interface TierColors {
  text: string;
  bg: string;
}

export const GOVERNANCE_TIER_COLORS: Record<GovernanceType, TierColors> = {
  centralized: { text: "text-yellow-700 dark:text-yellow-400", bg: "bg-yellow-500" },
  "centralized-dependent": { text: "text-orange-700 dark:text-orange-400", bg: "bg-orange-500" },
  decentralized: { text: "text-green-700 dark:text-green-400", bg: "bg-green-500" },
};

// ---------------------------------------------------------------------------
// Blacklist event badge styles
// ---------------------------------------------------------------------------

export const EVENT_BADGE_STYLES: Record<BlacklistEventType, string> = {
  blacklist: "bg-red-500/15 text-red-600 border-red-500/30 dark:text-red-400",
  unblacklist: "bg-emerald-500/15 text-emerald-600 border-emerald-500/20 dark:text-emerald-400",
  destroy: "bg-amber-500/15 text-amber-600 border-amber-500/30 dark:text-amber-400",
};

export const EVENT_LABELS: Record<BlacklistEventType, string> = {
  blacklist: "Blacklist",
  unblacklist: "Unblacklist",
  destroy: "Destroy",
};

// ---------------------------------------------------------------------------
// Peg currency chart colors (text + bg pairs for charts and stat cards)
// ---------------------------------------------------------------------------

export const PEG_CHART_COLORS = Object.fromEntries(
  (Object.entries(PEG_METADATA) as [PegCurrency, PegMetadata][])
    .flatMap(([peg, metadata]) => (metadata.chart ? [[peg, metadata.chart]] : [])),
) as Record<string, PegChartColor>;

// ---------------------------------------------------------------------------
// Yield type labels & styles
// ---------------------------------------------------------------------------

export const YIELD_TYPE_LABELS: Record<YieldType, string> = {
  "lending-vault": "Native",
  rebase: "Rebase",
  "fee-sharing": "Fee Share",
  "lp-receipt": "LP Receipt",
  "nav-appreciation": "NAV",
  "governance-set": "Gov. Set",
  "lending-opportunity": "Lending Opp.",
};

export const YIELD_TYPE_STYLES: Record<YieldType, { badge: string; hex: string }> = {
  "lending-vault": {
    badge: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
    hex: "#f97316",
  },
  rebase: { badge: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20", hex: "#8b5cf6" },
  "fee-sharing": { badge: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20", hex: "#06b6d4" },
  "lp-receipt": { badge: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20", hex: "#f59e0b" },
  "nav-appreciation": {
    badge: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
    hex: "#10b981",
  },
  "governance-set": {
    badge: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
    hex: "#f97316",
  },
  "lending-opportunity": { badge: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20", hex: "#0ea5e9" },
};

/** Chart hex colors for blacklist stablecoin breakdown.
 *  Intentionally per-stablecoin brand colors — independent of chart-colors.ts tokens. */
export const BLACKLIST_CHART_COLORS: Record<BlacklistStablecoin, string> = {
  USDT: "#06b6d4",
  USDC: "#3b82f6",
  PYUSD: "#6366f1",
  USD1: "#c026d3",
  USDG: "#14b8a6",
  RLUSD: "#e11d48",
  U: "#22c55e",
  USDTB: "#8b5cf6",
  A7A5: "#64748b",
  FDUSD: "#0f766e",
  BRZ: "#16a34a",
  EURC: "#1d4ed8",
  AUSD: "#0891b2",
  EURI: "#2563eb",
  USDQ: "#7c3aed",
  USDO: "#059669",
  USDX: "#dc2626",
  AID: "#9333ea",
  TGBP: "#be123c",
  MNEE: "#0d9488",
  BUIDL: "#111827",
  USDP: "#0ea5e9",
  PAXG: "#eab308",
  XAUT: "#f59e0b",
  TUSD: "#0284c7",
  NUSD: "#7c2d12",
  EURCV: "#1e3a8a",
  USDA: "#15803d",
  USAT: "#a21caf",
  AEUR: "#1e40af",
  XUSD: "#0e7490",
  XAUM: "#ca8a04",
  JPYC: "#ea580c",
  FRXUSD: "#f97316",
  FIDD: "#166534",
};

// ---------------------------------------------------------------------------
// Depeg Early Warning Score (DEWS) threat bands
// ---------------------------------------------------------------------------

export type ThreatBand = "CALM" | "WATCH" | "ALERT" | "WARNING" | "DANGER";

export const THREAT_BAND_ORDER: Record<ThreatBand, number> = {
  CALM: 0,
  WATCH: 1,
  ALERT: 2,
  WARNING: 3,
  DANGER: 4,
};

export function isThreatBand(value: string): value is ThreatBand {
  return value in THREAT_BAND_ORDER;
}

export const THREAT_BAND_LABELS: Record<ThreatBand, string> = {
  CALM: "Calm",
  WATCH: "Watch",
  ALERT: "Alert",
  WARNING: "Warning",
  DANGER: "Danger",
};

export const THREAT_BAND_COLORS: Record<ThreatBand, string> = {
  CALM: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20",
  WATCH: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20",
  ALERT: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20",
  WARNING: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20",
  DANGER: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20",
};

export const THREAT_BAND_TEXT_COLORS: Record<ThreatBand, string> = {
  CALM: "text-green-700 dark:text-green-400",
  WATCH: "text-teal-700 dark:text-teal-400",
  ALERT: "text-yellow-700 dark:text-yellow-400",
  WARNING: "text-orange-700 dark:text-orange-400",
  DANGER: "text-red-700 dark:text-red-400",
};

export const THREAT_BAND_HEX: Record<ThreatBand, string> = {
  CALM: "#22c55e",
  WATCH: "#14b8a6",
  ALERT: "#eab308",
  WARNING: "#f97316",
  DANGER: "#ef4444",
};

/**
 * Derive the highest DEWS risk level from an array of threat bands.
 * Returns a lowercase token suitable for UI styling: "danger" | "warning" | "alert" | "calm".
 */
export type DewsRiskLevel = "danger" | "warning" | "alert" | "calm";

export function getDewsRiskLevel(bands: ThreatBand[]): DewsRiskLevel {
  let maxOrder = 0;
  for (const band of bands) {
    const order = THREAT_BAND_ORDER[band] ?? 0;
    if (order > maxOrder) maxOrder = order;
  }
  if (maxOrder >= THREAT_BAND_ORDER.DANGER) return "danger";
  if (maxOrder >= THREAT_BAND_ORDER.WARNING) return "warning";
  if (maxOrder >= THREAT_BAND_ORDER.ALERT) return "alert";
  return "calm";
}

// ---------------------------------------------------------------------------
// Feature status badge styles
// ---------------------------------------------------------------------------

export type FeatureStatus = "mature" | "experimental" | "beta" | "testing-in-prod";

export const FEATURE_STATUS_CONFIG: Record<FeatureStatus, { label: string; cls: string }> = {
  mature: {
    label: "Mature",
    cls: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400 dark:border-emerald-500/40",
  },
  experimental: {
    label: "Beta",
    cls: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/40",
  },
  beta: {
    label: "Beta",
    cls: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/40",
  },
  "testing-in-prod": {
    label: "Testing in Prod",
    cls: "bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-400 dark:border-orange-500/40",
  },
};

// ---------------------------------------------------------------------------
// Cron status badge colors (status page cron cards)
// ---------------------------------------------------------------------------

/** Badge class strings keyed by cron run status. */
export const CRON_STATUS_COLORS: Record<"ok" | "degraded" | "skipped_locked" | "error", string> = {
  ok: "bg-green-500/15 text-green-700 dark:text-green-400",
  degraded: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  skipped_locked: "bg-muted text-muted-foreground",
  error: "bg-red-500/15 text-red-700 dark:text-red-400",
};

// ---------------------------------------------------------------------------
// Query error notice tone styles
// ---------------------------------------------------------------------------

interface NoticeToneStyle {
  readonly title: string;
  readonly message: string;
  readonly detail: string | null;
  readonly tone: string;
  readonly iconBg: string;
}

/** Style config keyed by query-error notice type.
 *  The `icon` field (a React component) is intentionally omitted — it belongs
 *  in the component layer, not in runtime-neutral shared lib. */
export const NOTICE_TONE_COLORS: Record<"stale" | "unavailable" | "network" | "error", NoticeToneStyle> = {
  stale: {
    title: "Refresh delayed",
    message: "Showing the last successful snapshot while live refresh retries.",
    detail: "The rest of this view should remain usable while the dataset catches up.",
    tone: "border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-400",
    iconBg: "bg-amber-500/15",
  },
  unavailable: {
    title: "Waiting for first sync",
    message: "This dataset has not populated yet.",
    detail: "Structural parts of the route may still render while the first successful snapshot is pending.",
    tone: "border-border/60 bg-muted/40 text-muted-foreground",
    iconBg: "bg-muted",
  },
  network: {
    title: "Connection issue",
    message: "Unable to reach the Pharos data API right now.",
    detail: "Retry when your connection stabilizes.",
    tone: "border-orange-500/30 bg-orange-500/8 text-orange-700 dark:text-orange-400",
    iconBg: "bg-orange-500/15",
  },
  error: {
    title: "Failed to load this dataset",
    message: "The dataset could not be loaded right now.",
    detail: null,
    tone: "border-red-500/30 bg-red-500/8 text-red-700 dark:text-red-400",
    iconBg: "bg-red-500/15",
  },
};

// ---------------------------------------------------------------------------
// Price transparency confidence level colors
// ---------------------------------------------------------------------------

/** Text color classes keyed by price-source confidence level. */
export const CONFIDENCE_LEVEL_COLORS: Record<"high" | "single-source" | "low" | "fallback", string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  "single-source": "text-amber-600 dark:text-amber-400",
  low: "text-rose-600 dark:text-rose-400",
  fallback: "text-muted-foreground",
};

// ---------------------------------------------------------------------------
// Data health banner state styles
// ---------------------------------------------------------------------------

/** Border/bg/text class strings keyed by data health state. */
export const DATA_HEALTH_COLORS: Record<"degraded" | "stale" | "unavailable" | "error", string> = {
  degraded: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  stale: "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  unavailable: "border-border/60 bg-muted/40 text-muted-foreground",
  error: "border-destructive/50 bg-destructive/10 text-destructive",
};

// ---------------------------------------------------------------------------
// Balance bar ratio quality colors
// ---------------------------------------------------------------------------

/** Background color classes for ratio quality segments in BalanceBar. */
export const RATIO_QUALITY_COLORS: Record<"healthy" | "caution" | "critical", string> = {
  healthy: "bg-emerald-500",
  caution: "bg-amber-500",
  critical: "bg-red-500",
};
