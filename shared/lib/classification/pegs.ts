import type { PegCurrency } from "../../types";
import type { PegMetadata } from "./common";

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
    chart: {
      label: "Euro",
      textColor: "text-violet-700 dark:text-violet-400",
      bgColor: "bg-violet-500",
      hex: "#8b5cf6",
    },
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
    chart: {
      label: "Real",
      textColor: "text-orange-700 dark:text-orange-400",
      bgColor: "bg-orange-500",
      hex: "#f97316",
    },
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
    chart: {
      label: "Rupiah",
      textColor: "text-amber-700 dark:text-amber-400",
      bgColor: "bg-amber-500",
      hex: "#f59e0b",
    },
  },
  INR: {
    label: "the Indian Rupee",
    shortLabel: "Indian Rupee",
    filterTag: "inr-peg",
    filterLabel: "INR",
    badge: {
      label: "INR Peg",
      cls: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400 border-emerald-600/20",
    },
    chart: {
      label: "Rupee",
      textColor: "text-emerald-700 dark:text-emerald-400",
      bgColor: "bg-emerald-600",
      hex: "#059669",
    },
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
  HKD: {
    label: "the Hong Kong Dollar",
    shortLabel: "Hong Kong Dollar",
    filterTag: "hkd-peg",
    filterLabel: "HKD",
    badge: {
      label: "HKD Peg",
      cls: "bg-blue-600/10 text-blue-700 dark:text-blue-400 border-blue-600/20",
    },
    chart: { label: "HKD", textColor: "text-blue-700 dark:text-blue-400", bgColor: "bg-blue-600", hex: "#2563eb" },
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
    chart: {
      label: "AUD",
      textColor: "text-indigo-700 dark:text-indigo-400",
      bgColor: "bg-indigo-500",
      hex: "#6366f1",
    },
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
    chart: {
      label: "Yuan",
      textColor: "text-purple-700 dark:text-purple-400",
      bgColor: "bg-purple-500",
      hex: "#a855f7",
    },
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
    chart: {
      label: "CNH",
      textColor: "text-purple-800 dark:text-purple-300",
      bgColor: "bg-purple-600",
      hex: "#9333ea",
    },
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
    chart: {
      label: "PHP",
      textColor: "text-emerald-700 dark:text-emerald-400",
      bgColor: "bg-emerald-500",
      hex: "#10b981",
    },
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
  VND: {
    label: "the Vietnamese Dong",
    shortLabel: "Vietnamese Dong",
    filterTag: "vnd-peg",
    filterLabel: "VND",
    badge: {
      label: "VND Peg",
      cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
    },
    chart: { label: "VND", textColor: "text-amber-700 dark:text-amber-400", bgColor: "bg-amber-500", hex: "#f59e0b" },
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
  KGS: {
    label: "the Kyrgyz Som",
    shortLabel: "Kyrgyz Som",
    filterTag: "kgs-peg",
    filterLabel: "KGS",
    badge: {
      label: "KGS Peg",
      cls: "bg-cyan-600/10 text-cyan-700 dark:text-cyan-400 border-cyan-600/20",
    },
    chart: { label: "KGS", textColor: "text-cyan-700 dark:text-cyan-400", bgColor: "bg-cyan-600", hex: "#0891b2" },
  },
  NGN: {
    label: "the Nigerian Naira",
    shortLabel: "Nigerian Naira",
    filterTag: "ngn-peg",
    filterLabel: "NGN",
    badge: {
      label: "NGN Peg",
      cls: "bg-green-600/10 text-green-700 dark:text-green-400 border-green-600/20",
    },
    chart: { label: "NGN", textColor: "text-green-700 dark:text-green-400", bgColor: "bg-green-600", hex: "#16a34a" },
  },
  XOF: {
    label: "the West African CFA Franc",
    shortLabel: "West African CFA Franc",
    filterTag: "xof-peg",
    filterLabel: "XOF",
    badge: {
      label: "XOF Peg",
      cls: "bg-teal-600/10 text-teal-700 dark:text-teal-400 border-teal-600/20",
    },
    chart: { label: "XOF", textColor: "text-teal-700 dark:text-teal-400", bgColor: "bg-teal-600", hex: "#0d9488" },
  },
  COP: {
    label: "the Colombian Peso",
    shortLabel: "Colombian Peso",
    filterTag: "cop-peg",
    filterLabel: "COP",
    badge: {
      label: "COP Peg",
      cls: "bg-gray-600/10 text-gray-700 dark:text-gray-400 border-gray-600/20",
    },
    chart: { label: "COP", textColor: "text-gray-700 dark:text-gray-400", bgColor: "bg-gray-600", hex: "#4b5563" },
  },
  CLP: {
    label: "the Chilean Peso",
    shortLabel: "Chilean Peso",
    filterTag: "clp-peg",
    filterLabel: "CLP",
    badge: {
      label: "CLP Peg",
      cls: "bg-zinc-600/10 text-zinc-700 dark:text-zinc-400 border-zinc-600/20",
    },
    chart: { label: "CLP", textColor: "text-zinc-700 dark:text-zinc-400", bgColor: "bg-zinc-600", hex: "#52525b" },
  },
  GHS: {
    label: "the Ghanaian Cedi",
    shortLabel: "Ghanaian Cedi",
    filterTag: "ghs-peg",
    filterLabel: "GHS",
    badge: {
      label: "GHS Peg",
      cls: "bg-lime-600/10 text-lime-700 dark:text-lime-400 border-lime-600/20",
    },
    chart: { label: "GHS", textColor: "text-lime-700 dark:text-lime-400", bgColor: "bg-lime-600", hex: "#65a30d" },
  },
  KES: {
    label: "the Kenyan Shilling",
    shortLabel: "Kenyan Shilling",
    filterTag: "kes-peg",
    filterLabel: "KES",
    badge: {
      label: "KES Peg",
      cls: "bg-emerald-600/10 text-emerald-700 dark:text-emerald-400 border-emerald-600/20",
    },
    chart: { label: "KES", textColor: "text-emerald-700 dark:text-emerald-400", bgColor: "bg-emerald-600", hex: "#059669" },
  },
  PEN: {
    label: "the Peruvian Sol",
    shortLabel: "Peruvian Sol",
    filterTag: "pen-peg",
    filterLabel: "PEN",
    badge: {
      label: "PEN Peg",
      cls: "bg-rose-600/10 text-rose-700 dark:text-rose-400 border-rose-600/20",
    },
    chart: { label: "PEN", textColor: "text-rose-700 dark:text-rose-400", bgColor: "bg-rose-600", hex: "#e11d48" },
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
    chart: {
      label: "Gold",
      textColor: "text-yellow-700 dark:text-yellow-400",
      bgColor: "bg-yellow-500",
      hex: "#eab308",
    },
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
    chart: { label: "CPI", textColor: "text-sky-700 dark:text-sky-400", bgColor: "bg-sky-500", hex: "#0ea5e9" },
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

export function mapPegMetadata<T>(select: (metadata: PegMetadata) => T): Record<PegCurrency, T> {
  return Object.fromEntries(Object.entries(PEG_METADATA).map(([peg, metadata]) => [peg, select(metadata)])) as Record<
    PegCurrency,
    T
  >;
}

/** Full labels with article, for prose descriptions. */
export const PEG_LABELS = mapPegMetadata((metadata) => metadata.label);

/** Labels without article, for metadata and keywords. */
export const PEG_LABELS_SHORT = mapPegMetadata((metadata) => metadata.shortLabel);

// Curated to high-volume pegs only; add a peg here when its stablecoin market cap
// is large enough to warrant a dedicated UI filter (e.g. multi-billion USD) or
// when the UX team approves expansion. Other pegs remain accessible via the "all" option.
export const PEG_FILTER_OPTIONS: { value: PegCurrency | "all"; label: string }[] = [
  { value: "all", label: "All pegs" },
  { value: "USD", label: PEG_METADATA.USD.filterLabel },
  { value: "EUR", label: PEG_METADATA.EUR.filterLabel },
  { value: "GOLD", label: PEG_METADATA.GOLD.filterLabel },
];

// ---------------------------------------------------------------------------
