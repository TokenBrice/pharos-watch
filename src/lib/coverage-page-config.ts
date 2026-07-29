import {
  Activity,
  ArrowUpDown,
  Droplets,
  KeyRound,
  Landmark,
  LifeBuoy,
  Network,
  ShieldBan,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import type { CoverageFeatureKey } from "@/lib/coverage";
import { COVERAGE_FEATURE_LEGEND_ITEMS } from "@/lib/coverage-features";

export type CoverageFilterKey =
  | "all"
  | "redemption"
  | "live-reserves"
  | "yield"
  | "flows"
  | "blacklist"
  | "weak-price"
  | "price-2-sources"
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
  mintAuthority: KeyRound,
};

export const FEATURE_ACCENT_CLASSES: Record<
  CoverageFeatureKey,
  {
    icon: string;
    countBar: string;
    chip: string;
    tile: string;
    title: string;
  }
> = {
  price: {
    icon: "text-muted-foreground",
    countBar: "bg-sky-400/80",
    chip: "border-sky-500/24 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  safety: {
    icon: "text-muted-foreground",
    countBar: "bg-emerald-400/80",
    chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  dex: {
    icon: "text-muted-foreground",
    countBar: "bg-cyan-400/80",
    chip: "border-cyan-500/24 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  reserves: {
    icon: "text-muted-foreground",
    countBar: "bg-amber-400/85",
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  redemption: {
    icon: "text-muted-foreground",
    countBar: "bg-rose-400/85",
    chip: "border-rose-500/24 bg-rose-500/10 text-rose-800 dark:text-rose-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  yield: {
    icon: "text-muted-foreground",
    countBar: "bg-teal-400/85",
    chip: "border-teal-500/24 bg-teal-500/10 text-teal-800 dark:text-teal-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  flows: {
    icon: "text-muted-foreground",
    countBar: "bg-indigo-400/85",
    chip: "border-indigo-500/24 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  blacklist: {
    icon: "text-muted-foreground",
    countBar: "bg-orange-400/85",
    chip: "border-orange-500/28 bg-orange-500/12 text-orange-800 dark:text-orange-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  dependency: {
    icon: "text-muted-foreground",
    countBar: "bg-frost-blue/85",
    chip: "border-frost-blue/24 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  mintAuthority: {
    icon: "text-muted-foreground",
    countBar: "bg-lime-400/85",
    chip: "border-lime-500/24 bg-lime-500/10 text-lime-800 dark:text-lime-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
};

export type BlacklistBreakdownStatusKind = "live" | "yes" | "upstream" | "possible" | "no";

const BLACKLIST_BREAKDOWN_CHIP_CLASS: Record<BlacklistBreakdownStatusKind, string> = {
  live: "border-rose-500/30 bg-rose-500/12 text-rose-800 dark:text-rose-200",
  yes: "border-red-500/30 bg-red-500/12 text-red-800 dark:text-red-200",
  upstream: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-200",
  possible: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200",
  no: "border-emerald-500/30 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200",
};

const COVERAGE_GAP_CHIP_CLASS = "border-border/70 bg-muted/60 text-muted-foreground";
export const COVERAGE_GAP_BAR_CLASS =
  "bg-muted-foreground/35 bg-[repeating-linear-gradient(135deg,transparent_0_5px,oklch(1_0_0_/0.08)_5px_10px)]";

export const COVERAGE_BREAKDOWN_VISUAL_CLASSES: Partial<
  Record<CoverageFeatureKey, Record<string, { chip: string; bar: string; barText?: string }>>
> = {
  price: {
    tracked: {
      chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      bar: "bg-sky-400/85",
      barText: "text-slate-950",
    },
    "price-only": {
      chip: "border-blue-500/24 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/75",
      barText: "text-slate-950",
    },
    "sources-5-plus": {
      chip: "border-emerald-500/26 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    "sources-3-4": {
      chip: "border-sky-500/26 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      bar: "bg-sky-400/85",
      barText: "text-slate-950",
    },
    "sources-1-2": {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/85",
      barText: "text-slate-950",
    },
    "data-unavailable": {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
  },
  safety: {
    rated: {
      chip: "border-emerald-500/28 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    nr: {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
    "data-unavailable": {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/75",
    },
  },
  dex: {
    primary: {
      chip: "border-emerald-500/28 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    mixed: {
      chip: "border-cyan-500/28 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
      bar: "bg-cyan-400/85",
      barText: "text-slate-950",
    },
    fallback: {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/85",
      barText: "text-slate-950",
    },
    "data-unavailable": {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
  },
  reserves: {
    live: {
      chip: "border-emerald-500/28 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    "live-configured": {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/80",
      barText: "text-slate-950",
    },
    checking: {
      chip: "border-yellow-500/28 bg-yellow-500/12 text-yellow-800 dark:text-yellow-200",
      bar: "bg-yellow-400/80",
      barText: "text-slate-950",
    },
    "curated-validated": {
      chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      bar: "bg-sky-400/80",
      barText: "text-slate-950",
    },
    proof: {
      chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
      bar: "bg-violet-400/80",
    },
    curated: {
      chip: "border-blue-500/26 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/80",
      barText: "text-slate-950",
    },
    estimated: {
      chip: "border-orange-500/28 bg-orange-500/12 text-orange-800 dark:text-orange-200",
      bar: "bg-orange-400/80",
      barText: "text-slate-950",
    },
  },
  redemption: {
    "modeled-heuristic": {
      chip: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/80",
      barText: "text-slate-950",
    },
    "resolved-unscored": {
      chip: "border-violet-500/30 bg-violet-500/12 text-violet-800 dark:text-violet-200",
      bar: "bg-violet-400/80",
    },
    "configured-unrated": {
      chip: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-200",
      bar: "bg-orange-400/80",
      barText: "text-slate-950",
    },
    impaired: {
      chip: "border-red-500/30 bg-red-500/12 text-red-800 dark:text-red-200",
      bar: "bg-red-400/80",
      barText: "text-slate-950",
    },
    "offchain-issuer": {
      chip: "border-rose-500/28 bg-rose-500/10 text-rose-800 dark:text-rose-200",
      bar: "bg-rose-400/85",
    },
    "psm-swap": {
      chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      bar: "bg-sky-400/85",
      barText: "text-slate-950",
    },
    "queue-redeem": {
      chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
      bar: "bg-violet-400/85",
    },
    "collateral-redeem": {
      chip: "border-blue-500/28 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/85",
      barText: "text-slate-950",
    },
    "stablecoin-redeem": {
      chip: "border-emerald-500/28 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    "basket-redeem": {
      chip: "border-teal-500/28 bg-teal-500/10 text-teal-800 dark:text-teal-200",
      bar: "bg-teal-400/85",
      barText: "text-slate-950",
    },
    "data-unavailable": {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
  },
  yield: {
    covered: {
      chip: "border-teal-500/28 bg-teal-500/10 text-teal-800 dark:text-teal-200",
      bar: "bg-teal-400/85",
      barText: "text-slate-950",
    },
    uncovered: {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
  },
  flows: {
    full: {
      chip: "border-indigo-500/28 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200",
      bar: "bg-indigo-400/85",
    },
    "partial-history": {
      chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      bar: "bg-sky-400/80",
      barText: "text-slate-950",
    },
    lagging: {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/80",
      barText: "text-slate-950",
    },
    bootstrapping: {
      chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
      bar: "bg-violet-400/80",
    },
    unknown: {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/75",
      barText: "text-slate-950",
    },
    "data-unavailable": {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
  },
  blacklist: {
    live: {
      chip: BLACKLIST_BREAKDOWN_CHIP_CLASS.live,
      bar: "bg-rose-400/90",
    },
    yes: {
      chip: BLACKLIST_BREAKDOWN_CHIP_CLASS.yes,
      bar: "bg-red-500/90",
    },
    upstream: {
      chip: BLACKLIST_BREAKDOWN_CHIP_CLASS.upstream,
      bar: "bg-orange-400/85",
      barText: "text-slate-950",
    },
    possible: {
      chip: BLACKLIST_BREAKDOWN_CHIP_CLASS.possible,
      bar: "bg-amber-400/85",
      barText: "text-slate-950",
    },
    no: {
      chip: BLACKLIST_BREAKDOWN_CHIP_CLASS.no,
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    "data-unavailable": {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
  },
  dependency: {
    both: {
      chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
      bar: "bg-violet-400/85",
    },
    dependent: {
      chip: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/85",
      barText: "text-slate-950",
    },
    upstream: {
      chip: "border-frost-blue/28 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
      bar: "bg-frost-blue/85",
      barText: "text-slate-950",
    },
    "resolved-none": {
      chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    gaps: {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
    "data-unavailable": {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
  },
  mintAuthority: {
    "no-privileged-mint": {
      chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    "governed-mint": {
      chip: "border-sky-500/26 bg-sky-500/10 text-sky-800 dark:text-sky-200",
      bar: "bg-sky-400/85",
      barText: "text-slate-950",
    },
    "multisig-mint": {
      chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
      bar: "bg-violet-400/80",
    },
    "issuer-or-backend-mint": {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/85",
      barText: "text-slate-950",
    },
    "bridge-mint": {
      chip: "border-cyan-500/28 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
      bar: "bg-cyan-400/85",
      barText: "text-slate-950",
    },
    "inherited-authority": {
      chip: "border-slate-500/24 bg-slate-500/10 text-slate-700 dark:text-slate-200",
      bar: "bg-slate-400/75",
      barText: "text-slate-950",
    },
    unknown: {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
    "score-hardened": {
      chip: "border-emerald-500/28 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: "text-slate-950",
    },
    "score-governed": {
      chip: "border-blue-500/26 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/85",
      barText: "text-slate-950",
    },
    "score-managed": {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/85",
      barText: "text-slate-950",
    },
    "score-concentrated": {
      chip: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-200",
      bar: "bg-orange-400/85",
      barText: "text-slate-950",
    },
    "score-exposed": {
      chip: "border-red-500/35 bg-red-500/12 text-red-800 dark:text-red-200",
      bar: "bg-red-400/85",
      barText: "text-slate-950",
    },
    "score-nr": {
      chip: COVERAGE_GAP_CHIP_CLASS,
      bar: COVERAGE_GAP_BAR_CLASS,
    },
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
  { key: "price-2-sources", group: "gap", label: "2 sources" },
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

export type LegendCategory = "general" | CoverageFeatureKey;

interface LegendItem {
  term: string;
  category: LegendCategory;
  description: string;
}

// General legend entries that are not tied to a specific feature's resolver
// (cross-cutting status terms surfaced by multiple features).
const GENERAL_LEGEND_ITEMS: readonly LegendItem[] = [
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
];

const LEGEND_CATEGORY_LABELS: Record<LegendCategory, string> = {
  general: "General",
  price: "Price & Depeg",
  safety: "Safety Score",
  dex: "DEX Liquidity",
  reserves: "Reserves",
  redemption: "Redemption",
  yield: "Yield",
  flows: "Flows",
  blacklist: "Blacklist Status",
  dependency: "Dependency",
  mintAuthority: "Mint Authority",
};

const LEGEND_CATEGORY_ORDER: readonly LegendCategory[] = [
  "general",
  "price",
  "safety",
  "dex",
  "reserves",
  "redemption",
  "yield",
  "flows",
  "blacklist",
  "dependency",
  "mintAuthority",
] as const;

// Assembled at module load: general entries + per-feature entries derived from
// COVERAGE_FEATURE_LEGEND_ITEMS, preserving the public LegendItem shape.
const LEGEND_ITEMS: readonly LegendItem[] = [
  ...GENERAL_LEGEND_ITEMS,
  ...LEGEND_CATEGORY_ORDER.filter((category): category is CoverageFeatureKey => category !== "general").flatMap(
    (category) =>
      COVERAGE_FEATURE_LEGEND_ITEMS[category].map((item) => ({
        term: item.term,
        category,
        description: item.description,
      })),
  ),
];

export function getLegendGroups(): ReadonlyArray<{
  label: string;
  items: ReadonlyArray<LegendItem>;
}> {
  return LEGEND_CATEGORY_ORDER.map((category) => ({
    label: LEGEND_CATEGORY_LABELS[category],
    items: LEGEND_ITEMS.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
}
