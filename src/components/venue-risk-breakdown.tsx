import type { YieldVenueRiskScoresPayload } from "@shared/types";
import { cn } from "@/lib/utils";

/**
 * Compact 5-factor Yearn-style venue-risk card (yield v8.292). Renders the five
 * category sub-scores (1–5, higher = riskier) behind the coarse venue tier so the
 * PYS venue penalty is explainable by factor. Data comes from a row's
 * `sourceRisk.venueRisk*` fields; render only when `scores` is present.
 */
export interface VenueRiskBreakdownProps {
  scores: YieldVenueRiskScoresPayload;
  tier?: "low" | "medium" | "high" | "unknown" | null;
  weighted?: number | null;
  confidence?: "verified" | "partial" | "low" | null;
}

const CATEGORY_ORDER = [
  "audits",
  "centralization",
  "fundsManagement",
  "liquidity",
  "operational",
] as const satisfies readonly (keyof YieldVenueRiskScoresPayload)[];

const CATEGORY_LABELS: Record<keyof YieldVenueRiskScoresPayload, string> = {
  audits: "Audits & track record",
  centralization: "Centralization & control",
  fundsManagement: "Funds management",
  liquidity: "Liquidity",
  operational: "Operational",
};

const TIER_TONE: Record<NonNullable<VenueRiskBreakdownProps["tier"]>, string> = {
  low: "text-emerald-700 dark:text-emerald-400",
  medium: "text-amber-700 dark:text-amber-400",
  high: "text-red-700 dark:text-red-400",
  unknown: "text-muted-foreground",
};

// 1–2 = safe (emerald), 3 = elevated (amber), 4–5 = risky (red).
function segmentTone(score: number, index: number): string {
  if (index >= score) return "bg-muted";
  if (score <= 2) return "bg-emerald-500";
  if (score === 3) return "bg-amber-500";
  return "bg-red-500";
}

export function VenueRiskBreakdown({ scores, tier, weighted, confidence }: VenueRiskBreakdownProps) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-3" role="group" aria-label="Venue risk breakdown">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Venue risk</p>
        <div className="flex items-baseline gap-1.5 text-xs">
          {tier ? <span className={cn("font-medium capitalize", TIER_TONE[tier])}>{tier}</span> : null}
          {typeof weighted === "number" && Number.isFinite(weighted) ? (
            <span className="font-mono tabular-nums text-muted-foreground">{weighted.toFixed(1)}/5</span>
          ) : null}
          {confidence && confidence !== "verified" ? (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">
              {confidence} confidence
            </span>
          ) : null}
        </div>
      </div>
      <dl className="mt-2 space-y-1.5">
        {CATEGORY_ORDER.map((key) => {
          const score = scores[key];
          return (
            <div key={key} className="flex items-center gap-2 text-xs">
              <dt className="w-[44%] shrink-0 text-muted-foreground">{CATEGORY_LABELS[key]}</dt>
              <dd
                className="flex flex-1 items-center gap-2"
                aria-label={`${CATEGORY_LABELS[key]}: ${score} out of 5`}
              >
                <span aria-hidden="true" className="flex flex-1 gap-0.5">
                  {[0, 1, 2, 3, 4].map((index) => (
                    <span key={index} className={cn("h-1.5 flex-1 rounded-full", segmentTone(score, index))} />
                  ))}
                </span>
                <span aria-hidden="true" className="w-6 text-right font-mono tabular-nums text-muted-foreground">
                  {score}/5
                </span>
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-2 text-[11px] text-muted-foreground">Yearn-style 5-category rubric · higher = riskier.</p>
    </div>
  );
}
