import {
  Activity,
  ArrowUpDown,
  Droplets,
  KeyRound,
  Landmark,
  LifeBuoy,
  Network,
  ScrollText,
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
  mica: Landmark,
  genius: ScrollText,
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
  mica: {
    icon: "text-muted-foreground",
    countBar: "bg-blue-400/85",
    chip: "border-blue-500/24 bg-blue-500/10 text-blue-800 dark:text-blue-200",
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  genius: {
    icon: "text-muted-foreground",
    countBar: "bg-purple-400/85",
    chip: "border-purple-500/24 bg-purple-500/10 text-purple-800 dark:text-purple-200",
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

const COVERAGE_GAP_CHIP_CLASS = "border-border/70 bg-muted/60 text-muted-foreground";
export const COVERAGE_GAP_BAR_CLASS =
  "bg-muted-foreground/35 bg-[repeating-linear-gradient(135deg,transparent_0_5px,oklch(1_0_0_/0.08)_5px_10px)]";

interface CoverageBreakdownVisual {
  chip: string;
  bar: string;
  barText?: string;
}

/** Bar label colour used whenever the bar fill is light enough for dark text. */
const BAR_TEXT_ON_LIGHT = "text-slate-950";

/**
 * Tone recipes shared by two or more `(feature, breakdown-kind)` pairs. Each
 * class value stays a complete literal so Tailwind keeps seeing it; the recipes
 * only remove the copy-paste, never compose class names at runtime.
 */
const BREAKDOWN_TONES = {
  /** Uncovered / not-applicable buckets (11 pairs). */
  gap: {
    chip: COVERAGE_GAP_CHIP_CLASS,
    bar: COVERAGE_GAP_BAR_CLASS,
  },
  emerald: {
    chip: "border-emerald-500/28 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    bar: "bg-emerald-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  emeraldFaint: {
    chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    bar: "bg-emerald-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  sky: {
    chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    bar: "bg-sky-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  skyFaint: {
    chip: "border-sky-500/26 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    bar: "bg-sky-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  skyMuted: {
    chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    bar: "bg-sky-400/80",
    barText: BAR_TEXT_ON_LIGHT,
  },
  cyan: {
    chip: "border-cyan-500/28 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
    bar: "bg-cyan-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  amber: {
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  amberMuted: {
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/80",
    barText: BAR_TEXT_ON_LIGHT,
  },
  amberStrong: {
    chip: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  orangeStrong: {
    chip: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-200",
    bar: "bg-orange-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
  violet: {
    chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
    bar: "bg-violet-400/85",
  },
  violetMuted: {
    chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
    bar: "bg-violet-400/80",
  },
  teal: {
    chip: "border-teal-500/28 bg-teal-500/10 text-teal-800 dark:text-teal-200",
    bar: "bg-teal-400/85",
    barText: BAR_TEXT_ON_LIGHT,
  },
} satisfies Record<string, CoverageBreakdownVisual>;

type BreakdownToneKey = keyof typeof BREAKDOWN_TONES;

/**
 * Per-feature breakdown visuals. A string picks a shared tone recipe; an inline
 * object is a deliberately bespoke pairing used by exactly one breakdown key.
 */
const COVERAGE_BREAKDOWN_TONES: Partial<
  Record<CoverageFeatureKey, Record<string, BreakdownToneKey | CoverageBreakdownVisual>>
> = {
  price: {
    tracked: "sky",
    "price-only": {
      chip: "border-blue-500/24 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/75",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "sources-5-plus": {
      chip: "border-emerald-500/26 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "sources-3-4": "skyFaint",
    "sources-1-2": "amber",
    "data-unavailable": "gap",
  },
  safety: {
    rated: "emerald",
    nr: "gap",
    // Amber-on-amber: the outage chip must not read as a coverage gap.
    "data-unavailable": {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/75",
    },
  },
  dex: {
    primary: "emerald",
    mixed: "cyan",
    fallback: "amber",
    "data-unavailable": "gap",
  },
  reserves: {
    live: "emerald",
    "live-configured": "amberMuted",
    checking: {
      chip: "border-yellow-500/28 bg-yellow-500/12 text-yellow-800 dark:text-yellow-200",
      bar: "bg-yellow-400/80",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "curated-validated": "skyMuted",
    proof: "violetMuted",
    curated: {
      chip: "border-blue-500/26 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/80",
      barText: BAR_TEXT_ON_LIGHT,
    },
    estimated: {
      chip: "border-orange-500/28 bg-orange-500/12 text-orange-800 dark:text-orange-200",
      bar: "bg-orange-400/80",
      barText: BAR_TEXT_ON_LIGHT,
    },
  },
  redemption: {
    "modeled-heuristic": {
      chip: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/80",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "resolved-unscored": {
      chip: "border-violet-500/30 bg-violet-500/12 text-violet-800 dark:text-violet-200",
      bar: "bg-violet-400/80",
    },
    "configured-unrated": {
      chip: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-200",
      bar: "bg-orange-400/80",
      barText: BAR_TEXT_ON_LIGHT,
    },
    impaired: {
      chip: "border-red-500/30 bg-red-500/12 text-red-800 dark:text-red-200",
      bar: "bg-red-400/80",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "offchain-issuer": {
      chip: "border-rose-500/28 bg-rose-500/10 text-rose-800 dark:text-rose-200",
      bar: "bg-rose-400/85",
    },
    "psm-swap": "sky",
    "queue-redeem": "violet",
    "collateral-redeem": {
      chip: "border-blue-500/28 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/85",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "stablecoin-redeem": "emerald",
    "basket-redeem": "teal",
    "data-unavailable": "gap",
  },
  yield: {
    covered: "teal",
    uncovered: "gap",
  },
  flows: {
    full: {
      chip: "border-indigo-500/28 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200",
      bar: "bg-indigo-400/85",
    },
    "partial-history": "skyMuted",
    lagging: "amberMuted",
    bootstrapping: "violetMuted",
    unknown: {
      chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
      bar: "bg-amber-400/75",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "data-unavailable": "gap",
  },
  blacklist: {
    live: {
      chip: "border-rose-500/30 bg-rose-500/12 text-rose-800 dark:text-rose-200",
      bar: "bg-rose-400/90",
    },
    yes: {
      chip: "border-red-500/30 bg-red-500/12 text-red-800 dark:text-red-200",
      bar: "bg-red-500/90",
    },
    upstream: "orangeStrong",
    possible: "amberStrong",
    no: {
      chip: "border-emerald-500/30 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200",
      bar: "bg-emerald-400/85",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "data-unavailable": "gap",
  },
  mica: {
    authorized: "emerald",
    pending: "amber",
    transitional: "amberMuted",
    "non-compliant": {
      chip: "border-red-500/35 bg-red-500/12 text-red-800 dark:text-red-200",
      bar: "bg-red-400/85",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "out-of-scope": "gap",
    unassessed: "gap",
  },
  genius: {
    "ppsi-approved": "emerald",
    "state-qualified": "emeraldFaint",
    "official-application-pending": "amber",
    "issuer-announced-intent": "sky",
    "no-public-authorization-found": "gap",
    "not-applicable": "gap",
    unknown: "amberMuted",
    unassessed: "gap",
  },
  dependency: {
    both: "violet",
    dependent: "amberStrong",
    upstream: {
      chip: "border-frost-blue/28 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
      bar: "bg-frost-blue/85",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "resolved-none": "emeraldFaint",
    gaps: "gap",
    "data-unavailable": "gap",
  },
  mintAuthority: {
    "no-privileged-mint": "emeraldFaint",
    "governed-mint": "skyFaint",
    "multisig-mint": "violetMuted",
    "issuer-or-backend-mint": "amber",
    "bridge-mint": "cyan",
    "inherited-authority": {
      chip: "border-slate-500/24 bg-slate-500/10 text-slate-700 dark:text-slate-200",
      bar: "bg-slate-400/75",
      barText: BAR_TEXT_ON_LIGHT,
    },
    unknown: "gap",
    "score-hardened": "emerald",
    "score-governed": {
      chip: "border-blue-500/26 bg-blue-500/10 text-blue-800 dark:text-blue-200",
      bar: "bg-blue-400/85",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "score-managed": "amber",
    "score-concentrated": "orangeStrong",
    "score-exposed": {
      chip: "border-red-500/35 bg-red-500/12 text-red-800 dark:text-red-200",
      bar: "bg-red-400/85",
      barText: BAR_TEXT_ON_LIGHT,
    },
    "score-nr": "gap",
  },
};

function resolveBreakdownVisual(spec: BreakdownToneKey | CoverageBreakdownVisual): CoverageBreakdownVisual {
  return typeof spec === "string" ? BREAKDOWN_TONES[spec] : spec;
}

export const COVERAGE_BREAKDOWN_VISUAL_CLASSES: Partial<
  Record<CoverageFeatureKey, Record<string, CoverageBreakdownVisual>>
> = Object.fromEntries(
  Object.entries(COVERAGE_BREAKDOWN_TONES).map(([feature, kinds]) => [
    feature,
    Object.fromEntries(Object.entries(kinds).map(([kind, spec]) => [kind, resolveBreakdownVisual(spec)])),
  ]),
);
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
  mica: "MiCA",
  genius: "GENIUS",
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
  "mica",
  "genius",
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
