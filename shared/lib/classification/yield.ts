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
