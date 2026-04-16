import {
  Activity,
  ArrowUpDown,
  Droplets,
  Landmark,
  LifeBuoy,
  Network,
  ShieldBan,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import type { CoverageFeatureKey } from "@/lib/coverage";

export type CoverageFilterKey =
  | "all"
  | "redemption"
  | "live-reserves"
  | "yield"
  | "flows"
  | "blacklist"
  | "weak-price"
  | "missing-safety"
  | "missing-dex"
  | "missing-live-reserves"
  | "missing-flows"
  | "missing-dependency"
  | "full-available"
  | "full-headline";

export type CoverageSortKey =
  | "market-cap"
  | "name"
  | "most-covered"
  | "least-covered"
  | "most-headline"
  | "least-headline"
  | "weakest-price"
  | "weakest-safety"
  | "weakest-dex"
  | "weakest-reserves"
  | "weakest-redemption"
  | "weakest-yield"
  | "weakest-flows"
  | "weakest-dependency";

export const FEATURE_ICON: Record<CoverageFeatureKey, typeof Activity> = {
  price: Activity,
  safety: ShieldCheck,
  dex: Droplets,
  reserves: Landmark,
  redemption: LifeBuoy,
  yield: TrendingUp,
  flows: ArrowUpDown,
  blacklist: ShieldBan,
  dependency: Network,
};

export const FEATURE_ACCENT_CLASSES: Record<
  CoverageFeatureKey,
  {
    rail: string;
    ring: string;
    icon: string;
    countBar: string;
    chip: string;
    tile: string;
    title: string;
  }
> = {
  price: {
    rail: "before:bg-sky-400/70",
    ring: "border-sky-500/28 bg-sky-500/10",
    icon: "text-sky-700 dark:text-sky-300",
    countBar: "bg-sky-400/80",
    chip: "border-sky-500/24 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    tile: "border-sky-500/18 bg-sky-500/6",
    title: "text-sky-800 dark:text-sky-100",
  },
  safety: {
    rail: "before:bg-emerald-400/70",
    ring: "border-emerald-500/28 bg-emerald-500/10",
    icon: "text-emerald-700 dark:text-emerald-300",
    countBar: "bg-emerald-400/80",
    chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    tile: "border-emerald-500/18 bg-emerald-500/6",
    title: "text-emerald-800 dark:text-emerald-100",
  },
  dex: {
    rail: "before:bg-cyan-400/70",
    ring: "border-cyan-500/28 bg-cyan-500/10",
    icon: "text-cyan-700 dark:text-cyan-300",
    countBar: "bg-cyan-400/80",
    chip: "border-cyan-500/24 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
    tile: "border-cyan-500/18 bg-cyan-500/6",
    title: "text-cyan-800 dark:text-cyan-100",
  },
  reserves: {
    rail: "before:bg-amber-400/75",
    ring: "border-amber-500/30 bg-amber-500/10",
    icon: "text-amber-700 dark:text-amber-300",
    countBar: "bg-amber-400/85",
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    tile: "border-amber-500/18 bg-amber-500/6",
    title: "text-amber-800 dark:text-amber-100",
  },
  redemption: {
    rail: "before:bg-rose-400/75",
    ring: "border-rose-500/28 bg-rose-500/10",
    icon: "text-rose-700 dark:text-rose-300",
    countBar: "bg-rose-400/85",
    chip: "border-rose-500/24 bg-rose-500/10 text-rose-800 dark:text-rose-200",
    tile: "border-rose-500/18 bg-rose-500/6",
    title: "text-rose-800 dark:text-rose-100",
  },
  yield: {
    rail: "before:bg-teal-400/75",
    ring: "border-teal-500/28 bg-teal-500/10",
    icon: "text-teal-700 dark:text-teal-300",
    countBar: "bg-teal-400/85",
    chip: "border-teal-500/24 bg-teal-500/10 text-teal-800 dark:text-teal-200",
    tile: "border-teal-500/18 bg-teal-500/6",
    title: "text-teal-800 dark:text-teal-100",
  },
  flows: {
    rail: "before:bg-indigo-400/75",
    ring: "border-indigo-500/28 bg-indigo-500/10",
    icon: "text-indigo-700 dark:text-indigo-300",
    countBar: "bg-indigo-400/85",
    chip: "border-indigo-500/24 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200",
    tile: "border-indigo-500/18 bg-indigo-500/6",
    title: "text-indigo-800 dark:text-indigo-100",
  },
  blacklist: {
    rail: "before:bg-orange-400/75",
    ring: "border-orange-500/30 bg-orange-500/10",
    icon: "text-orange-700 dark:text-orange-300",
    countBar: "bg-orange-400/85",
    chip: "border-orange-500/28 bg-orange-500/12 text-orange-800 dark:text-orange-200",
    tile: "border-orange-500/18 bg-orange-500/6",
    title: "text-orange-800 dark:text-orange-100",
  },
  dependency: {
    rail: "before:bg-frost-blue/75",
    ring: "border-frost-blue/28 bg-frost-blue/10",
    icon: "text-frost-blue",
    countBar: "bg-frost-blue/85",
    chip: "border-frost-blue/24 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
    tile: "border-frost-blue/18 bg-frost-blue/6",
    title: "text-sky-800 dark:text-sky-100",
  },
};

export const AUTHORITATIVE_ACCENT = {
  container: "border-violet-500/25 bg-violet-500/[0.03]",
  badge: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  card: "border-violet-500/30 bg-violet-500/10",
  cardLabel: "text-violet-800 dark:text-violet-300",
} as const;

export type CoverageFilterGroup = "tier" | "feature" | "gap";

export const FILTER_OPTIONS: ReadonlyArray<{
  key: CoverageFilterKey;
  label: string;
  group: CoverageFilterGroup;
}> = [
  { key: "all", group: "tier", label: "All coins" },
  { key: "full-available", group: "tier", label: "Fully available" },
  { key: "full-headline", group: "tier", label: "Fully headline" },
  { key: "redemption", group: "feature", label: "Redemption" },
  { key: "yield", group: "feature", label: "Yield" },
  { key: "live-reserves", group: "feature", label: "Reserves" },
  { key: "flows", group: "feature", label: "Flows" },
  { key: "blacklist", group: "feature", label: "Blacklist" },
  { key: "missing-safety", group: "gap", label: "No Safety" },
  { key: "missing-dex", group: "gap", label: "No DEX" },
  { key: "missing-live-reserves", group: "gap", label: "No Reserves" },
  { key: "weak-price", group: "gap", label: "Weak price" },
  { key: "missing-flows", group: "gap", label: "No Flows" },
  { key: "missing-dependency", group: "gap", label: "No Dependency" },
] as const;

const FILTER_GROUPS: readonly CoverageFilterGroup[] = ["tier", "feature", "gap"] as const;

export function getFilterGroups(): ReadonlyArray<ReadonlyArray<(typeof FILTER_OPTIONS)[number]>> {
  return FILTER_GROUPS.map((group) => FILTER_OPTIONS.filter((option) => option.group === group));
}

export const SORT_OPTIONS: ReadonlyArray<{
  group: string;
  options: ReadonlyArray<{
    key: CoverageSortKey;
    label: string;
  }>;
}> = [
  {
    group: "Overview",
    options: [
      { key: "market-cap", label: "Market cap" },
      { key: "name", label: "Alphabetical" },
      { key: "most-covered", label: "Most available" },
      { key: "least-covered", label: "Least available" },
      { key: "most-headline", label: "Most headline" },
      { key: "least-headline", label: "Weakest headline" },
    ],
  },
  {
    group: "Weakest Feature First",
    options: [
      { key: "weakest-price", label: "Price" },
      { key: "weakest-safety", label: "Safety" },
      { key: "weakest-dex", label: "DEX" },
      { key: "weakest-reserves", label: "Reserves" },
      { key: "weakest-redemption", label: "Redemption" },
      { key: "weakest-yield", label: "Yield" },
      { key: "weakest-flows", label: "Flows" },
      { key: "weakest-dependency", label: "Dependency" },
    ],
  },
] as const;

export const MOBILE_PREVIEW_FEATURES: readonly CoverageFeatureKey[] = [
  "price",
  "safety",
  "dex",
  "reserves",
  "redemption",
  "flows",
] as const;

export type LegendCategory = "general" | "price" | "dex" | "reserves" | "redemption" | "flows" | "dependency";

export const LEGEND_ITEMS = [
  {
    term: "NR",
    category: "general",
    description: "No current rating or observed row is available for that surface.",
  },
  {
    term: "Data n/a",
    category: "general",
    description:
      "The backing feed failed or has not returned usable data, so the state is not counted as a coverage gap.",
  },
  {
    term: "—",
    category: "general",
    description: "Pharos does not currently expose that feature for the asset.",
  },
  {
    term: "Tracked",
    category: "price",
    description: "Price and depeg monitoring are available. Source count appears when the price pipeline reports it.",
  },
  {
    term: "Price only",
    category: "price",
    description: "NAV-priced asset with price coverage, but no peg or depeg tracking.",
  },
  {
    term: "Primary / Mixed / Fallback",
    category: "dex",
    description:
      "DEX coverage quality: primary sources, blended primary plus fallback sources, or fallback-only discovery.",
  },
  {
    term: "Score-grade",
    category: "reserves",
    description: "Fresh independent live reserve data was used by the current report-card snapshot for collateral scoring.",
  },
  {
    term: "Configured",
    category: "reserves",
    description: "A reserve view or live reserve adapter exists, but the current report-card snapshot did not use it for collateral scoring.",
  },
  {
    term: "Checking",
    category: "reserves",
    description:
      "Reserve coverage is configured, but report-card freshness data is still loading or unavailable.",
  },
  {
    term: "Curated-Validated",
    category: "reserves",
    description: "A reviewed reserve baseline is kept current through live validation.",
  },
  {
    term: "Proof",
    category: "reserves",
    description: "Reserve view is backed by proof, attestation, or liveness evidence rather than a full live mix.",
  },
  {
    term: "Curated / Estimated",
    category: "reserves",
    description: "Reserve composition is manually curated or falls back to classification-based estimates.",
  },
  {
    term: "Issuer / PSM / Queue / Collat. / Stable / Basket",
    category: "redemption",
    description: "The modeled redemption-backstop route family counted as strong redemption coverage.",
  },
  {
    term: "Heur.",
    category: "redemption",
    description:
      "A redemption route is modeled, but the current capacity evidence is still heuristic / low-confidence and does not count as strong coverage.",
  },
  {
    term: "Config.",
    category: "redemption",
    description: "A redemption route is configured, but the current snapshot could not resolve a usable score.",
  },
  {
    term: "Full / Partial / Lagging / Bootstr.",
    category: "flows",
    description: "Mint/burn flow coverage maturity and sync state for configured assets.",
  },
  {
    term: "Bootstr.",
    category: "flows",
    description: "Tracking is configured, but the history window is still building.",
  },
  {
    term: "Node",
    category: "dependency",
    description: "The asset participates in the report-card dependency graph.",
  },
] as const;

const LEGEND_CATEGORY_LABELS: Record<LegendCategory, string> = {
  general: "General",
  price: "Price & Depeg",
  dex: "DEX Liquidity",
  reserves: "Reserves",
  redemption: "Redemption",
  flows: "Flows",
  dependency: "Dependency",
};

const LEGEND_CATEGORY_ORDER: readonly LegendCategory[] = [
  "general",
  "price",
  "dex",
  "reserves",
  "redemption",
  "flows",
  "dependency",
] as const;

export function getLegendGroups(): ReadonlyArray<{
  label: string;
  items: ReadonlyArray<(typeof LEGEND_ITEMS)[number]>;
}> {
  return LEGEND_CATEGORY_ORDER
    .map((category) => ({
      label: LEGEND_CATEGORY_LABELS[category],
      items: LEGEND_ITEMS.filter((item) => item.category === category),
    }))
    .filter((group) => group.items.length > 0);
}
