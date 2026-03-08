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
  YieldType,
} from "../types";
import { TRACKED_STABLECOINS } from "./stablecoins";

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

// ---------------------------------------------------------------------------
// Peg currency labels
// ---------------------------------------------------------------------------

/** Full labels with article, for prose descriptions. */
export const PEG_LABELS: Record<PegCurrency, string> = {
  USD: "the US Dollar",
  EUR: "the Euro",
  GBP: "the British Pound",
  CHF: "the Swiss Franc",
  BRL: "the Brazilian Real",
  RUB: "the Russian Ruble",
  JPY: "the Japanese Yen",
  IDR: "the Indonesian Rupiah",
  SGD: "the Singapore Dollar",
  TRY: "the Turkish Lira",
  AUD: "the Australian Dollar",
  ZAR: "the South African Rand",
  CAD: "the Canadian Dollar",
  CNY: "the Chinese Yuan",
  CNH: "the Offshore Yuan",
  PHP: "the Philippine Peso",
  MXN: "the Mexican Peso",
  UAH: "the Ukrainian Hryvnia",
  ARS: "the Argentine Peso",
  GOLD: "Gold",
  SILVER: "Silver",
  VAR: "CPI",
  OTHER: "Other",
};

/** Number of distinct peg currencies actually tracked (with at least one stablecoin). */
export const PEG_CURRENCY_COUNT = new Set(TRACKED_STABLECOINS.map((s) => s.flags.pegCurrency)).size;

/** Labels without article, for metadata and keywords. */
export const PEG_LABELS_SHORT: Record<PegCurrency, string> = {
  USD: "US Dollar",
  EUR: "Euro",
  GBP: "British Pound",
  CHF: "Swiss Franc",
  BRL: "Brazilian Real",
  RUB: "Russian Ruble",
  JPY: "Japanese Yen",
  IDR: "Indonesian Rupiah",
  SGD: "Singapore Dollar",
  TRY: "Turkish Lira",
  AUD: "Australian Dollar",
  ZAR: "South African Rand",
  CAD: "Canadian Dollar",
  CNY: "Chinese Yuan",
  CNH: "Offshore Yuan",
  PHP: "Philippine Peso",
  MXN: "Mexican Peso",
  UAH: "Ukrainian Hryvnia",
  ARS: "Argentine Peso",
  GOLD: "Gold",
  SILVER: "Silver",
  VAR: "CPI",
  OTHER: "Other",
};

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

interface BadgeStyle {
  label: string;
  cls: string;
}
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
export const PEG_BADGE_STYLES: Record<PegCurrency, BadgeStyle> = {
  USD: { label: "USD Peg", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
  EUR: { label: "EUR Peg", cls: "bg-violet-500/10 text-violet-700 dark:text-violet-400 border-violet-500/20" },
  CHF: { label: "CHF Peg", cls: "bg-pink-500/10 text-pink-700 dark:text-pink-400 border-pink-500/20" },
  GBP: { label: "GBP Peg", cls: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-400 border-cyan-500/20" },
  BRL: { label: "BRL Peg", cls: "bg-orange-500/10 text-orange-700 dark:text-orange-400 border-orange-500/20" },
  RUB: { label: "RUB Peg", cls: "bg-red-500/10 text-red-700 dark:text-red-400 border-red-500/20" },
  JPY: { label: "JPY Peg", cls: "bg-rose-500/10 text-rose-700 dark:text-rose-400 border-rose-500/20" },
  IDR: { label: "IDR Peg", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20" },
  SGD: { label: "SGD Peg", cls: "bg-teal-500/10 text-teal-700 dark:text-teal-400 border-teal-500/20" },
  TRY: { label: "TRY Peg", cls: "bg-lime-500/10 text-lime-700 dark:text-lime-400 border-lime-500/20" },
  AUD: { label: "AUD Peg", cls: "bg-indigo-500/10 text-indigo-700 dark:text-indigo-400 border-indigo-500/20" },
  ZAR: { label: "ZAR Peg", cls: "bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-400 border-fuchsia-500/20" },
  CAD: { label: "CAD Peg", cls: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20" },
  CNY: { label: "CNY Peg", cls: "bg-purple-500/10 text-purple-700 dark:text-purple-400 border-purple-500/20" },
  CNH: { label: "CNH Peg", cls: "bg-purple-600/10 text-purple-800 dark:text-purple-300 border-purple-600/20" },
  PHP: { label: "PHP Peg", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20" },
  MXN: { label: "MXN Peg", cls: "bg-green-500/10 text-green-700 dark:text-green-400 border-green-500/20" },
  UAH: { label: "UAH Peg", cls: "bg-sky-600/10 text-sky-600 border-sky-600/20" },
  ARS: { label: "ARS Peg", cls: "bg-stone-500/10 text-stone-700 dark:text-stone-400 border-stone-500/20" },
  GOLD: { label: "Gold Peg", cls: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400 border-yellow-500/20" },
  SILVER: { label: "Silver Peg", cls: "bg-gray-400/10 text-gray-700 dark:text-gray-400 border-gray-400/20" },
  VAR: { label: "CPI Peg", cls: "bg-sky-500/10 text-sky-700 dark:text-sky-400 border-sky-500/20" },
  OTHER: { label: "Other Peg", cls: "bg-slate-500/10 text-slate-700 dark:text-slate-400 border-slate-500/20" },
};

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

export const PEG_CHART_COLORS: Record<string, { label: string; textColor: string; bgColor: string; hex: string }> = {
  GOLD: { label: "Gold", textColor: "text-yellow-700 dark:text-yellow-400", bgColor: "bg-yellow-500", hex: "#eab308" },
  EUR: { label: "Euro", textColor: "text-violet-700 dark:text-violet-400", bgColor: "bg-violet-500", hex: "#8b5cf6" },
  RUB: { label: "Ruble", textColor: "text-red-700 dark:text-red-400", bgColor: "bg-red-500", hex: "#ef4444" },
  BRL: { label: "Real", textColor: "text-orange-700 dark:text-orange-400", bgColor: "bg-orange-500", hex: "#f97316" },
  CHF: { label: "Franc", textColor: "text-pink-700 dark:text-pink-400", bgColor: "bg-pink-500", hex: "#ec4899" },
  GBP: { label: "Pound", textColor: "text-cyan-700 dark:text-cyan-400", bgColor: "bg-cyan-500", hex: "#06b6d4" },
  JPY: { label: "Yen", textColor: "text-rose-700 dark:text-rose-400", bgColor: "bg-rose-500", hex: "#f43f5e" },
  IDR: { label: "Rupiah", textColor: "text-amber-700 dark:text-amber-400", bgColor: "bg-amber-500", hex: "#f59e0b" },
  SGD: { label: "SGD", textColor: "text-teal-700 dark:text-teal-400", bgColor: "bg-teal-500", hex: "#14b8a6" },
  TRY: { label: "Lira", textColor: "text-lime-700 dark:text-lime-400", bgColor: "bg-lime-500", hex: "#84cc16" },
  AUD: { label: "AUD", textColor: "text-indigo-700 dark:text-indigo-400", bgColor: "bg-indigo-500", hex: "#6366f1" },
  ZAR: {
    label: "Rand",
    textColor: "text-fuchsia-700 dark:text-fuchsia-400",
    bgColor: "bg-fuchsia-500",
    hex: "#d946ef",
  },
  CAD: { label: "CAD", textColor: "text-blue-700 dark:text-blue-400", bgColor: "bg-blue-500", hex: "#3b82f6" },
  CNY: { label: "Yuan", textColor: "text-purple-700 dark:text-purple-400", bgColor: "bg-purple-500", hex: "#a855f7" },
  CNH: { label: "CNH", textColor: "text-purple-800 dark:text-purple-300", bgColor: "bg-purple-600", hex: "#9333ea" },
  PHP: { label: "PHP", textColor: "text-emerald-700 dark:text-emerald-400", bgColor: "bg-emerald-500", hex: "#10b981" },
  MXN: { label: "MXN", textColor: "text-green-700 dark:text-green-400", bgColor: "bg-green-500", hex: "#22c55e" },
  UAH: { label: "UAH", textColor: "text-sky-600", bgColor: "bg-sky-600", hex: "#0284c7" },
  ARS: { label: "ARS", textColor: "text-stone-700 dark:text-stone-400", bgColor: "bg-stone-500", hex: "#78716c" },
  SILVER: { label: "Silver", textColor: "text-gray-700 dark:text-gray-400", bgColor: "bg-gray-400", hex: "#9ca3af" },
  VAR: { label: "CPI", textColor: "text-slate-700 dark:text-slate-400", bgColor: "bg-slate-500", hex: "#64748b" },
  OTHER: { label: "Other", textColor: "text-slate-700 dark:text-slate-400", bgColor: "bg-slate-500", hex: "#64748b" },
};

// ---------------------------------------------------------------------------
// Yield type labels & styles
// ---------------------------------------------------------------------------

export const YIELD_TYPE_LABELS: Record<YieldType, string> = {
  "lending-vault": "Lending",
  rebase: "Rebase",
  "fee-sharing": "Fee Share",
  "lp-receipt": "LP Receipt",
  "nav-appreciation": "NAV",
  "governance-set": "Gov. Set",
  "lending-opportunity": "Lending Opp.",
};

export const YIELD_TYPE_STYLES: Record<YieldType, { badge: string; hex: string }> = {
  "lending-vault": { badge: "bg-blue-500/10 text-blue-700 dark:text-blue-400 border-blue-500/20", hex: "#3b82f6" },
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

/** Chart hex colors for blacklist stablecoin breakdown */
export const BLACKLIST_CHART_COLORS: Record<BlacklistStablecoin, string> = {
  USDT: "#06b6d4",
  USDC: "#3b82f6",
  EURC: "#22c55e",
  PAXG: "#eab308",
  XAUT: "#f59e0b",
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

export const THREAT_BAND_HEX: Record<ThreatBand, string> = {
  CALM: "#22c55e",
  WATCH: "#14b8a6",
  ALERT: "#eab308",
  WARNING: "#f97316",
  DANGER: "#ef4444",
};

// ---------------------------------------------------------------------------
// Feature status badge styles
// ---------------------------------------------------------------------------

export type FeatureStatus = "mature" | "experimental" | "testing-in-prod";

export const FEATURE_STATUS_CONFIG: Record<FeatureStatus, { label: string; cls: string }> = {
  mature: {
    label: "Mature",
    cls: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30 dark:text-emerald-400 dark:border-emerald-500/40",
  },
  experimental: {
    label: "Experimental",
    cls: "bg-amber-500/15 text-amber-700 border-amber-500/30 dark:text-amber-400 dark:border-amber-500/40",
  },
  "testing-in-prod": {
    label: "Testing in Prod",
    cls: "bg-orange-500/15 text-orange-700 border-orange-500/30 dark:text-orange-400 dark:border-orange-500/40",
  },
};
