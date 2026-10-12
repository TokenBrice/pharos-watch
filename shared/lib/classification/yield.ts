interface PysDescriptor {
  min: number;
  textClassName: string;
  barClassName: string;
}

const PYS_DESCRIPTORS: readonly PysDescriptor[] = [
  { min: 41, textClassName: "text-emerald-700 dark:text-emerald-400", barClassName: "bg-emerald-500" },
  { min: 21, textClassName: "text-amber-700 dark:text-amber-400", barClassName: "bg-amber-500" },
  { min: Number.NEGATIVE_INFINITY, textClassName: "text-red-700 dark:text-red-400", barClassName: "bg-red-500" },
];
const PYS_UNRATED = { textClassName: "text-muted-foreground", barClassName: "bg-muted-foreground/40" };

function resolvePysDescriptor(score: number | null | undefined) {
  return score == null ? PYS_UNRATED : (PYS_DESCRIPTORS.find((descriptor) => score >= descriptor.min) ?? PYS_UNRATED);
}

export function getPysColor(score: number | null | undefined): string {
  return resolvePysDescriptor(score).textClassName;
}

export function getPysBarColor(score: number | null | undefined): string {
  // The gauge historically treats a non-null NaN as red; text remains unrated.
  return Number.isNaN(score) ? PYS_DESCRIPTORS[2].barClassName : resolvePysDescriptor(score).barClassName;
}

export type YieldRiskBudgetKey = "conservative" | "balanced" | "opportunistic" | "all";

/** Risk-budget slider stops, conservative → all. */
export const YIELD_RISK_BUDGET_CLASSES = {
  conservative: {
    dot: "bg-emerald-500",
    dotBorder: "border-emerald-500",
    ring: "ring-emerald-500/25",
    trackFill: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
    activeCount: "text-emerald-700 dark:text-emerald-200",
  },
  balanced: {
    dot: "bg-green-500",
    dotBorder: "border-green-500",
    ring: "ring-green-500/25",
    trackFill: "bg-green-500",
    text: "text-green-700 dark:text-green-300",
    activeCount: "text-green-700 dark:text-green-200",
  },
  opportunistic: {
    dot: "bg-amber-500",
    dotBorder: "border-amber-500",
    ring: "ring-amber-500/25",
    trackFill: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
    activeCount: "text-amber-700 dark:text-amber-200",
  },
  all: {
    dot: "bg-orange-500",
    dotBorder: "border-orange-500",
    ring: "ring-orange-500/30",
    trackFill: "bg-orange-500",
    text: "text-orange-700 dark:text-orange-300",
    activeCount: "text-orange-700 dark:text-orange-200",
  },
} as const satisfies Record<YieldRiskBudgetKey, {
  dot: string;
  dotBorder: string;
  ring: string;
  trackFill: string;
  text: string;
  activeCount: string;
}>;

/** Yield history source-strip lanes, assigned in first-appearance order. */
export const YIELD_SERIES_FILL_CLASSES: readonly string[] = [
  "bg-emerald-500/40",
  "bg-sky-500/40",
  "bg-amber-500/40",
  "bg-violet-500/40",
  "bg-rose-500/40",
];
