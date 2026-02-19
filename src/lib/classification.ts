/**
 * Single-source-of-truth for classification labels, badge colors, and style maps.
 *
 * All consumer components should import from here instead of defining local copies.
 * Tailwind class strings are always complete static literals (never constructed dynamically).
 */

import type { GovernanceType, BackingType, PegCurrency, ProofOfReservesType, BlacklistEventType } from "./types";

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
  GOLD: "Gold",
  SILVER: "Silver",
  VAR: "CPI",
  OTHER: "Other",
};

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
  "centralized-dependent": "bg-orange-500/10 text-orange-500 border-orange-500/20",
  decentralized: "bg-green-500/10 text-green-500 border-green-500/20",
};

/** Backing badge colors used in the main table. */
export const BACKING_COLORS: Record<BackingType, string> = {
  "rwa-backed": "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "crypto-backed": "bg-purple-500/10 text-purple-500 border-purple-500/20",
  algorithmic: "bg-orange-500/10 text-orange-500 border-orange-500/20",
};

// ---------------------------------------------------------------------------
// Combined label+class style maps (for detail page pill badges)
// ---------------------------------------------------------------------------

export interface BadgeStyle {
  label: string;
  cls: string;
}

/** Governance badge styles for the detail page. */
export const GOVERNANCE_BADGE_STYLES: Record<GovernanceType, BadgeStyle> = {
  centralized: { label: "Centralized", cls: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
  "centralized-dependent": { label: "CeFi-Dependent", cls: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
  decentralized: { label: "Decentralized", cls: "bg-green-500/10 text-green-500 border-green-500/20" },
};

/** Backing badge styles for the detail page. */
export const BACKING_BADGE_STYLES: Record<BackingType, BadgeStyle> = {
  "rwa-backed": { label: "RWA-Backed", cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  "crypto-backed": { label: "Crypto-Backed", cls: "bg-purple-500/10 text-purple-500 border-purple-500/20" },
  algorithmic: { label: "Algorithmic", cls: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
};

/** Peg currency badge styles for the detail page. */
export const PEG_BADGE_STYLES: Record<PegCurrency, BadgeStyle> = {
  USD: { label: "USD Peg", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  EUR: { label: "EUR Peg", cls: "bg-violet-500/10 text-violet-500 border-violet-500/20" },
  CHF: { label: "CHF Peg", cls: "bg-pink-500/10 text-pink-500 border-pink-500/20" },
  GBP: { label: "GBP Peg", cls: "bg-cyan-500/10 text-cyan-500 border-cyan-500/20" },
  BRL: { label: "BRL Peg", cls: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
  RUB: { label: "RUB Peg", cls: "bg-red-500/10 text-red-500 border-red-500/20" },
  JPY: { label: "JPY Peg", cls: "bg-rose-500/10 text-rose-500 border-rose-500/20" },
  IDR: { label: "IDR Peg", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
  SGD: { label: "SGD Peg", cls: "bg-teal-500/10 text-teal-500 border-teal-500/20" },
  TRY: { label: "TRY Peg", cls: "bg-lime-500/10 text-lime-500 border-lime-500/20" },
  AUD: { label: "AUD Peg", cls: "bg-indigo-500/10 text-indigo-500 border-indigo-500/20" },
  ZAR: { label: "ZAR Peg", cls: "bg-fuchsia-500/10 text-fuchsia-500 border-fuchsia-500/20" },
  GOLD: { label: "Gold Peg", cls: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
  SILVER: { label: "Silver Peg", cls: "bg-gray-400/10 text-gray-400 border-gray-400/20" },
  VAR: { label: "CPI Peg", cls: "bg-sky-500/10 text-sky-500 border-sky-500/20" },
  OTHER: { label: "Other Peg", cls: "bg-slate-500/10 text-slate-500 border-slate-500/20" },
};

/** Proof-of-reserves badge styles for the detail page. */
export const POR_BADGE_STYLES: Record<ProofOfReservesType, BadgeStyle> = {
  "independent-audit": { label: "Independent Audit", cls: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
  "real-time": { label: "Real-Time PoR", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  "self-reported": { label: "Self-Reported PoR", cls: "bg-amber-500/10 text-amber-500 border-amber-500/20" },
};

// ---------------------------------------------------------------------------
// Governance chart/stat card colors (text + bg pairs for bar segments & legends)
// ---------------------------------------------------------------------------

export interface TierColors {
  text: string;
  bg: string;
}

export const GOVERNANCE_TIER_COLORS: Record<GovernanceType, TierColors> = {
  centralized: { text: "text-yellow-500", bg: "bg-yellow-500" },
  "centralized-dependent": { text: "text-orange-500", bg: "bg-orange-500" },
  decentralized: { text: "text-green-500", bg: "bg-green-500" },
};

// ---------------------------------------------------------------------------
// Bluechip safety grade colors
// ---------------------------------------------------------------------------

export const GRADE_COLORS: Record<string, string> = {
  "A+": "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  A: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  "A-": "bg-emerald-500/10 text-emerald-500 border-emerald-500/20",
  "B+": "bg-blue-500/10 text-blue-500 border-blue-500/20",
  B: "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "B-": "bg-blue-500/10 text-blue-500 border-blue-500/20",
  "C+": "bg-amber-500/10 text-amber-500 border-amber-500/20",
  C: "bg-amber-500/10 text-amber-500 border-amber-500/20",
  "C-": "bg-amber-500/10 text-amber-500 border-amber-500/20",
  D: "bg-red-500/10 text-red-500 border-red-500/20",
  F: "bg-red-500/10 text-red-500 border-red-500/20",
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
  GOLD: { label: "Gold", textColor: "text-yellow-500", bgColor: "bg-yellow-500", hex: "#eab308" },
  EUR: { label: "Euro", textColor: "text-violet-500", bgColor: "bg-violet-500", hex: "#8b5cf6" },
  RUB: { label: "Ruble", textColor: "text-red-500", bgColor: "bg-red-500", hex: "#ef4444" },
  BRL: { label: "Real", textColor: "text-orange-500", bgColor: "bg-orange-500", hex: "#f97316" },
  CHF: { label: "Franc", textColor: "text-pink-500", bgColor: "bg-pink-500", hex: "#ec4899" },
  GBP: { label: "Pound", textColor: "text-cyan-500", bgColor: "bg-cyan-500", hex: "#06b6d4" },
  JPY: { label: "Yen", textColor: "text-rose-500", bgColor: "bg-rose-500", hex: "#f43f5e" },
  IDR: { label: "Rupiah", textColor: "text-amber-500", bgColor: "bg-amber-500", hex: "#f59e0b" },
  SGD: { label: "SGD", textColor: "text-teal-500", bgColor: "bg-teal-500", hex: "#14b8a6" },
  TRY: { label: "Lira", textColor: "text-lime-500", bgColor: "bg-lime-500", hex: "#84cc16" },
  AUD: { label: "AUD", textColor: "text-indigo-500", bgColor: "bg-indigo-500", hex: "#6366f1" },
  ZAR: { label: "Rand", textColor: "text-fuchsia-500", bgColor: "bg-fuchsia-500", hex: "#d946ef" },
  SILVER: { label: "Silver", textColor: "text-gray-400", bgColor: "bg-gray-400", hex: "#9ca3af" },
  VAR: { label: "CPI", textColor: "text-slate-500 dark:text-slate-400", bgColor: "bg-slate-500", hex: "#64748b" },
  OTHER: { label: "Other", textColor: "text-slate-500 dark:text-slate-400", bgColor: "bg-slate-500", hex: "#64748b" },
};

/** Chart hex colors for blacklist stablecoin breakdown */
export const BLACKLIST_CHART_COLORS: Record<string, string> = {
  USDT: "#06b6d4",
  USDC: "#3b82f6",
  PAXG: "#eab308",
  XAUT: "#f59e0b",
};
