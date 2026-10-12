/**
 * Product-feature identity and the /coverage, /methodology, /api and /status
 * accent palettes. /coverage is the canonical feature directory, so its hues
 * define `FEATURE_IDENTITY_CLASSES`; the methodology section accents project
 * from that one palette instead of choosing their own hue per page.
 */

export type CoverageFeatureKey =
  | "price"
  | "safety"
  | "dex"
  | "reserves"
  | "redemption"
  | "yield"
  | "flows"
  | "blacklist"
  | "mica"
  | "genius"
  | "dependency"
  | "mintAuthority";

export type CoverageTone = "emerald" | "sky" | "amber" | "violet" | "rose" | "slate";

/** Methodology-only features carry an identity too, so every section accent comes from one palette. */
export type FeatureIdentityKey =
  | CoverageFeatureKey
  | "chainHealth"
  | "stabilityIndex"
  | "pegscoreDews"
  | "depegResolver";

export const FEATURE_IDENTITY_CLASSES = {
  price: { hue: "sky", changelogHover: "hover:text-sky-700 dark:hover:text-sky-400" },
  safety: { hue: "emerald", changelogHover: "hover:text-emerald-700 dark:hover:text-emerald-400" },
  dex: { hue: "cyan", changelogHover: "hover:text-cyan-700 dark:hover:text-cyan-400" },
  reserves: { hue: "amber", changelogHover: "hover:text-amber-700 dark:hover:text-amber-400" },
  redemption: { hue: "rose", changelogHover: "hover:text-rose-700 dark:hover:text-rose-400" },
  yield: { hue: "teal", changelogHover: "hover:text-teal-700 dark:hover:text-teal-400" },
  flows: { hue: "indigo", changelogHover: "hover:text-indigo-700 dark:hover:text-indigo-400" },
  blacklist: { hue: "orange", changelogHover: "hover:text-orange-700 dark:hover:text-orange-400" },
  mica: { hue: "blue", changelogHover: "hover:text-blue-700 dark:hover:text-blue-400" },
  genius: { hue: "purple", changelogHover: "hover:text-purple-700 dark:hover:text-purple-400" },
  dependency: { hue: "frost-blue", changelogHover: "hover:text-sky-700 dark:hover:text-sky-400" },
  mintAuthority: { hue: "lime", changelogHover: "hover:text-lime-700 dark:hover:text-lime-400" },
  // Methodology-only identities take hues no coverage feature uses, so no two
  // /methodology sections share an accent.
  chainHealth: { hue: "fuchsia", changelogHover: "hover:text-fuchsia-700 dark:hover:text-fuchsia-400" },
  stabilityIndex: { hue: "pink", changelogHover: "hover:text-pink-700 dark:hover:text-pink-400" },
  pegscoreDews: { hue: "yellow", changelogHover: "hover:text-yellow-700 dark:hover:text-yellow-400" },
  depegResolver: { hue: "violet", changelogHover: "hover:text-violet-700 dark:hover:text-violet-400" },
} as const satisfies Record<FeatureIdentityKey, { hue: string; changelogHover: string }>;

/** /coverage feature accents; the hue of each entry is `FEATURE_IDENTITY_CLASSES[feature].hue`. */
export const COVERAGE_FEATURE_ACCENT_CLASSES = {
  price: {
    countBar: "bg-sky-400/80",
    chip: "border-sky-500/24 bg-sky-500/10 text-sky-800 dark:text-sky-200",
  },
  safety: {
    countBar: "bg-emerald-400/80",
    chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
  },
  dex: {
    countBar: "bg-cyan-400/80",
    chip: "border-cyan-500/24 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
  },
  reserves: {
    countBar: "bg-amber-400/85",
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
  },
  redemption: {
    countBar: "bg-rose-400/85",
    chip: "border-rose-500/24 bg-rose-500/10 text-rose-800 dark:text-rose-200",
  },
  yield: {
    countBar: "bg-teal-400/85",
    chip: "border-teal-500/24 bg-teal-500/10 text-teal-800 dark:text-teal-200",
  },
  flows: {
    countBar: "bg-indigo-400/85",
    chip: "border-indigo-500/24 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200",
  },
  blacklist: {
    countBar: "bg-orange-400/85",
    chip: "border-orange-500/28 bg-orange-500/12 text-orange-800 dark:text-orange-200",
  },
  mica: {
    countBar: "bg-blue-400/85",
    chip: "border-blue-500/24 bg-blue-500/10 text-blue-800 dark:text-blue-200",
  },
  genius: {
    countBar: "bg-purple-400/85",
    chip: "border-purple-500/24 bg-purple-500/10 text-purple-800 dark:text-purple-200",
  },
  dependency: {
    countBar: "bg-frost-blue/85",
    chip: "border-frost-blue/24 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
  },
  mintAuthority: {
    countBar: "bg-lime-400/85",
    chip: "border-lime-500/24 bg-lime-500/10 text-lime-800 dark:text-lime-200",
  },
} as const satisfies Record<CoverageFeatureKey, { countBar: string; chip: string }>;

const COVERAGE_GAP_CHIP_CLASS = "border-border/70 bg-muted/60 text-muted-foreground";
export const COVERAGE_GAP_BAR_CLASS =
  "bg-muted-foreground/35 bg-[repeating-linear-gradient(135deg,transparent_0_5px,oklch(1_0_0_/0.08)_5px_10px)]";

/** Bar label colour used whenever the bar fill is light enough for dark text. */
export const COVERAGE_BAR_TEXT_ON_LIGHT_CLASS = "text-slate-950";

export interface CoverageBreakdownToneClasses {
  chip: string;
  bar: string;
  barText?: string;
}

/**
 * Every breakdown chip/bar spelling on /coverage. Near-identical keys differ
 * deliberately in border alpha (`/24`-`/35`), tint (`/10`, `/12`), bar alpha
 * (`/75`-`/90`) or bar text; collapsing them would be a visible change.
 */
export const COVERAGE_BREAKDOWN_TONE_CLASSES = {
  /** Uncovered / not-applicable buckets. */
  gap: { chip: COVERAGE_GAP_CHIP_CLASS, bar: COVERAGE_GAP_BAR_CLASS },
  emerald: {
    chip: "border-emerald-500/28 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    bar: "bg-emerald-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  emeraldFaint: {
    chip: "border-emerald-500/24 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    bar: "bg-emerald-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  emeraldSoft: {
    chip: "border-emerald-500/26 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
    bar: "bg-emerald-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  emeraldStrong: {
    chip: "border-emerald-500/30 bg-emerald-500/12 text-emerald-800 dark:text-emerald-200",
    bar: "bg-emerald-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  sky: {
    chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    bar: "bg-sky-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  skyFaint: {
    chip: "border-sky-500/26 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    bar: "bg-sky-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  skyMuted: {
    chip: "border-sky-500/28 bg-sky-500/10 text-sky-800 dark:text-sky-200",
    bar: "bg-sky-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  cyan: {
    chip: "border-cyan-500/28 bg-cyan-500/10 text-cyan-800 dark:text-cyan-200",
    bar: "bg-cyan-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  blue: {
    chip: "border-blue-500/28 bg-blue-500/10 text-blue-800 dark:text-blue-200",
    bar: "bg-blue-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  blueSoft: {
    chip: "border-blue-500/26 bg-blue-500/10 text-blue-800 dark:text-blue-200",
    bar: "bg-blue-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  blueSoftMuted: {
    chip: "border-blue-500/26 bg-blue-500/10 text-blue-800 dark:text-blue-200",
    bar: "bg-blue-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  blueFaintDim: {
    chip: "border-blue-500/24 bg-blue-500/10 text-blue-800 dark:text-blue-200",
    bar: "bg-blue-400/75",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  frostBlue: {
    chip: "border-frost-blue/28 bg-frost-blue/10 text-sky-800 dark:text-sky-200",
    bar: "bg-frost-blue/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  indigo: {
    chip: "border-indigo-500/28 bg-indigo-500/10 text-indigo-800 dark:text-indigo-200",
    bar: "bg-indigo-400/85",
  },
  amber: {
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  amberMuted: {
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  amberDim: {
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/75",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  /** Amber-on-amber outage chip: no bar text, so it does not read as a coverage gap. */
  amberOutage: {
    chip: "border-amber-500/28 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/75",
  },
  amberStrong: {
    chip: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  amberStrongMuted: {
    chip: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-200",
    bar: "bg-amber-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  yellow: {
    chip: "border-yellow-500/28 bg-yellow-500/12 text-yellow-800 dark:text-yellow-200",
    bar: "bg-yellow-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  orangeMuted: {
    chip: "border-orange-500/28 bg-orange-500/12 text-orange-800 dark:text-orange-200",
    bar: "bg-orange-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  orangeStrong: {
    chip: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-200",
    bar: "bg-orange-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  orangeStrongMuted: {
    chip: "border-orange-500/30 bg-orange-500/12 text-orange-800 dark:text-orange-200",
    bar: "bg-orange-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  redStrong: {
    chip: "border-red-500/30 bg-red-500/12 text-red-800 dark:text-red-200",
    bar: "bg-red-500/90",
  },
  redStrongMuted: {
    chip: "border-red-500/30 bg-red-500/12 text-red-800 dark:text-red-200",
    bar: "bg-red-400/80",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  redHeavy: {
    chip: "border-red-500/35 bg-red-500/12 text-red-800 dark:text-red-200",
    bar: "bg-red-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  rose: {
    chip: "border-rose-500/28 bg-rose-500/10 text-rose-800 dark:text-rose-200",
    bar: "bg-rose-400/85",
  },
  roseStrong: {
    chip: "border-rose-500/30 bg-rose-500/12 text-rose-800 dark:text-rose-200",
    bar: "bg-rose-400/90",
  },
  violet: {
    chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
    bar: "bg-violet-400/85",
  },
  violetMuted: {
    chip: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-200",
    bar: "bg-violet-400/80",
  },
  violetStrongMuted: {
    chip: "border-violet-500/30 bg-violet-500/12 text-violet-800 dark:text-violet-200",
    bar: "bg-violet-400/80",
  },
  teal: {
    chip: "border-teal-500/28 bg-teal-500/10 text-teal-800 dark:text-teal-200",
    bar: "bg-teal-400/85",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
  slate: {
    chip: "border-slate-500/24 bg-slate-500/10 text-slate-700 dark:text-slate-200",
    bar: "bg-slate-400/75",
    barText: COVERAGE_BAR_TEXT_ON_LIGHT_CLASS,
  },
} as const satisfies Record<string, CoverageBreakdownToneClasses>;

export type CoverageBreakdownToneKey = keyof typeof COVERAGE_BREAKDOWN_TONE_CLASSES;

export const COVERAGE_BADGE_TONE_CLASSES = {
  emerald: "border-emerald-500/22 bg-emerald-500/8 text-emerald-800 dark:text-emerald-300",
  sky: "border-sky-500/24 bg-sky-500/8 text-sky-800 dark:text-sky-300",
  amber: "border-amber-500/30 bg-amber-500/12 text-amber-800 dark:text-amber-300",
  violet: "border-violet-500/28 bg-violet-500/10 text-violet-800 dark:text-violet-300",
  rose: "border-rose-500/35 bg-rose-500/12 text-rose-800 dark:text-rose-300",
  slate:
    "border-border/70 bg-muted/70 text-muted-foreground bg-[repeating-linear-gradient(135deg,transparent_0_5px,oklch(1_0_0_/0.04)_5px_10px)]",
} as const satisfies Record<CoverageTone, string>;

export const COVERAGE_AUTHORITATIVE_ACCENT_CLASSES = {
  container: "border-violet-500/25 bg-violet-500/[0.03]",
  badge: "border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300",
  card: "border-violet-500/30 bg-violet-500/10",
  cardLabel: "text-violet-800 dark:text-violet-300",
} as const;

/** API method badges (reference panel sections, directory and sidebar). */
export const HTTP_METHOD_BADGE_CLASSES = {
  GET: "border-emerald-500/25 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  POST: "border-amber-500/25 bg-amber-500/15 text-amber-700 dark:text-amber-400",
} as const satisfies Record<"GET" | "POST", string>;

export type MethodologySectionAccentKey =
  | "pricing"
  | "chainHealth"
  | "stabilityIndex"
  | "yieldIntelligence"
  | "pegscoreDews"
  | "depegResolver"
  | "blacklist"
  | "redemptionBackstop"
  | "mintBurnFlow"
  | "safetyScores"
  | "liquidity";

/** Methodology section accents: each section takes its feature's identity hue. */
export const METHODOLOGY_SECTION_ACCENT_CLASSES = {
  pricing: { changelogHover: FEATURE_IDENTITY_CLASSES.price.changelogHover },
  chainHealth: { changelogHover: FEATURE_IDENTITY_CLASSES.chainHealth.changelogHover },
  stabilityIndex: { changelogHover: FEATURE_IDENTITY_CLASSES.stabilityIndex.changelogHover },
  yieldIntelligence: { changelogHover: FEATURE_IDENTITY_CLASSES.yield.changelogHover },
  pegscoreDews: { changelogHover: FEATURE_IDENTITY_CLASSES.pegscoreDews.changelogHover },
  depegResolver: { changelogHover: FEATURE_IDENTITY_CLASSES.depegResolver.changelogHover },
  blacklist: { changelogHover: FEATURE_IDENTITY_CLASSES.blacklist.changelogHover },
  redemptionBackstop: { changelogHover: FEATURE_IDENTITY_CLASSES.redemption.changelogHover },
  mintBurnFlow: { changelogHover: FEATURE_IDENTITY_CLASSES.flows.changelogHover },
  safetyScores: { changelogHover: FEATURE_IDENTITY_CLASSES.safety.changelogHover },
  liquidity: { changelogHover: FEATURE_IDENTITY_CLASSES.dex.changelogHover },
} as const satisfies Record<MethodologySectionAccentKey, { changelogHover: string }>;

/** Column-group accent borders on methodology tables. */
export const METHODOLOGY_TABLE_ACCENT_CLASSES = {
  pricingMarket: "border-orange-500/40",
  pricingOverride: "border-blue-500/40",
  psiConditionBand: "border-pink-500/40",
  safetyScoring: "border-emerald-500/40",
} as const;

export const STATUS_RELIABILITY_ACCENT_CLASSES = {
  endpoints: "border-indigo-500 bg-indigo-500/[0.05]",
  sources: "border-cyan-500 bg-cyan-500/[0.05]",
} as const;
