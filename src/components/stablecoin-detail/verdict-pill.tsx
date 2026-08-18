import { SEVERITY_TONE_CLASS, type SeverityTone } from "@/lib/severity-tone";
import type { StablecoinVerdict, StablecoinVerdictArchetype } from "@shared/lib/stablecoin-verdict";

/** Archetype → severity tone. `null` is the uncategorized opt-out. */
const ARCHETYPE_TONE: Record<StablecoinVerdictArchetype, SeverityTone | null> = {
  "pre-launch": "info",
  "quarantined-record": "watch",
  "delisted-record": "neutral",
  "frozen-archive": "neutral",
  distressed: "alert",
  // `watch`, not `alert`: a low grade measures our evidence and scoring, not a
  // failing asset. `alert` stays with the measured-distress archetype.
  "low-safety-score": "watch",
  "yield-bearing-hybrid": "ok",
  "decentralized-benchmark": "ok",
  "institutional-default": "ok",
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
  const severityTone = ARCHETYPE_TONE[verdict.archetype];
  if (severityTone === null) return null;
  const tone = SEVERITY_TONE_CLASS[severityTone].pill;
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
