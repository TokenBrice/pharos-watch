import type { StablecoinVerdict, StablecoinVerdictArchetype } from "@shared/lib/stablecoin-verdict";

const ARCHETYPE_TONE: Record<StablecoinVerdictArchetype, string | null> = {
  "pre-launch":
    "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  "quarantined-record":
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  "delisted-record":
    "border-border/60 bg-muted/60 text-muted-foreground",
  "frozen-archive":
    "border-border/60 bg-muted/60 text-muted-foreground",
  distressed:
    "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
  "yield-bearing-hybrid":
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "decentralized-benchmark":
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  "institutional-default":
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  uncategorized: null,
};

interface VerdictPillProps {
  id?: string;
  verdict: StablecoinVerdict;
}

/**
 * Pure-derived archetype label rendered above the hero metric strip.
 * Renders `null` for the `uncategorized` archetype — honest emptiness rather
 * than mislabelling a coin whose inputs don't match any defined rule.
 */
export function VerdictPill({ id, verdict }: VerdictPillProps) {
  const tone = ARCHETYPE_TONE[verdict.archetype];
  if (tone === null) return null;
  return (
    <span
      id={id}
      data-archetype={verdict.archetype}
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${tone}`}
    >
      {verdict.label}
    </span>
  );
}
