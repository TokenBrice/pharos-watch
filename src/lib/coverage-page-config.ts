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
import {
  COVERAGE_AUTHORITATIVE_ACCENT_CLASSES,
  COVERAGE_BREAKDOWN_TONE_CLASSES,
  COVERAGE_FEATURE_ACCENT_CLASSES,
  COVERAGE_GAP_BAR_CLASS,
  type CoverageBreakdownToneKey,
} from "@shared/lib/classification";
import type { CoverageFeatureKey } from "@/lib/coverage";
import { COVERAGE_FEATURES } from "@/lib/coverage-features";

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

export { COVERAGE_GAP_BAR_CLASS };

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
    ...COVERAGE_FEATURE_ACCENT_CLASSES.price,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  safety: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.safety,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  dex: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.dex,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  reserves: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.reserves,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  redemption: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.redemption,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  yield: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.yield,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  flows: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.flows,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  blacklist: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.blacklist,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  mica: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.mica,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  genius: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.genius,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  dependency: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.dependency,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
  mintAuthority: {
    icon: "text-muted-foreground",
    ...COVERAGE_FEATURE_ACCENT_CLASSES.mintAuthority,
    tile: "border-border/60 bg-muted/40",
    title: "text-foreground",
  },
};

interface CoverageBreakdownVisual {
  chip: string;
  bar: string;
  barText?: string;
}

/** Per-feature breakdown visuals; each kind picks a recipe from `COVERAGE_BREAKDOWN_TONE_CLASSES`. */
const COVERAGE_BREAKDOWN_TONES: Partial<
  Record<CoverageFeatureKey, Record<string, CoverageBreakdownToneKey>>
> = {
  price: {
    tracked: "sky",
    "price-only": "blueFaintDim",
    "sources-5-plus": "emeraldSoft",
    "sources-3-4": "skyFaint",
    "sources-1-2": "amber",
    "data-unavailable": "gap",
  },
  safety: {
    rated: "emerald",
    nr: "gap",
    "data-unavailable": "amberOutage",
  },
  dex: {
    primary: "emerald",
    mixed: "cyan",
    fallback: "amber",
    legacy: "violet",
    "data-unavailable": "gap",
  },
  reserves: {
    live: "emerald",
    "live-configured": "amberMuted",
    checking: "yellow",
    "curated-validated": "skyMuted",
    proof: "violetMuted",
    curated: "blueSoftMuted",
    estimated: "orangeMuted",
    "data-unavailable": "gap",
  },
  redemption: {
    "modeled-heuristic": "amberStrongMuted",
    "resolved-unscored": "violetStrongMuted",
    "configured-unrated": "orangeStrongMuted",
    impaired: "redStrongMuted",
    "offchain-issuer": "rose",
    "psm-swap": "sky",
    "queue-redeem": "violet",
    "collateral-redeem": "blue",
    "stablecoin-redeem": "emerald",
    "basket-redeem": "teal",
    "data-unavailable": "gap",
  },
  yield: {
    covered: "teal",
    uncovered: "gap",
    "data-unavailable": "gap",
  },
  flows: {
    full: "indigo",
    "partial-history": "skyMuted",
    lagging: "amberMuted",
    bootstrapping: "violetMuted",
    unknown: "amberDim",
    "data-unavailable": "gap",
  },
  blacklist: {
    live: "roseStrong",
    yes: "redStrong",
    upstream: "orangeStrong",
    possible: "amberStrong",
    no: "emeraldStrong",
    "data-unavailable": "gap",
  },
  mica: {
    authorized: "emerald",
    pending: "amber",
    transitional: "amberMuted",
    "non-compliant": "redHeavy",
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
    upstream: "frostBlue",
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
    "inherited-authority": "slate",
    unknown: "gap",
    "score-hardened": "emerald",
    "score-governed": "blueSoft",
    "score-managed": "amber",
    "score-concentrated": "orangeStrong",
    "score-exposed": "redHeavy",
    "score-nr": "gap",
  },
};

function resolveBreakdownVisual(spec: CoverageBreakdownToneKey): CoverageBreakdownVisual {
  return COVERAGE_BREAKDOWN_TONE_CLASSES[spec];
}

export const COVERAGE_BREAKDOWN_VISUAL_CLASSES: Partial<
  Record<CoverageFeatureKey, Record<string, CoverageBreakdownVisual>>
> = Object.fromEntries(
  Object.entries(COVERAGE_BREAKDOWN_TONES).map(([feature, kinds]) => [
    feature,
    Object.fromEntries(Object.entries(kinds).map(([kind, spec]) => [kind, resolveBreakdownVisual(spec)])),
  ]),
);
export const AUTHORITATIVE_ACCENT = COVERAGE_AUTHORITATIVE_ACCENT_CLASSES;

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

const LEGEND_CATEGORY_ORDER: readonly LegendCategory[] = [
  "general",
  ...COVERAGE_FEATURES.map((feature) => feature.key),
] as const;

// Assembled at module load from the feature registry, preserving the public LegendItem shape.
const LEGEND_ITEMS: readonly LegendItem[] = [
  ...GENERAL_LEGEND_ITEMS,
  ...LEGEND_CATEGORY_ORDER.filter((category): category is CoverageFeatureKey => category !== "general").flatMap(
    (category) =>
      COVERAGE_FEATURES.find((feature) => feature.key === category)!.legendItems.map((item) => ({
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
    label:
      category === "general"
        ? "General"
        : COVERAGE_FEATURES.find((feature) => feature.key === category)!.legendLabel ??
          COVERAGE_FEATURES.find((feature) => feature.key === category)!.label,
    items: LEGEND_ITEMS.filter((item) => item.category === category),
  })).filter((group) => group.items.length > 0);
}
