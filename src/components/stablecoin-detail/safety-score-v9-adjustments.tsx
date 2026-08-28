import { Award, ShieldCheck } from "lucide-react";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { humanizeSafetyScoreV9Value } from "@/lib/stablecoin-safety-score-v9-presentation";

export function ScoreAdjustment({ card }: { card: SafetyScoreV9CurrentCard }) {
  const adjustment = card.scoreTrace.scoreAdjustments[0];
  if (!adjustment) return null;
  return (
    <section className="border-b border-border/40 pb-3" aria-labelledby={`${card.id}-v9-adjustment`}>
      <div className="flex items-center gap-2">
        <Award className="h-4 w-4 text-emerald-700 dark:text-emerald-400" aria-hidden="true" />
        <h3 id={`${card.id}-v9-adjustment`} className="text-sm font-semibold">{adjustment.label}</h3>
        <span className="font-mono text-xs font-semibold text-emerald-700 dark:text-emerald-400">
          +{adjustment.appliedPoints.toFixed(0)}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Published score rises from {adjustment.publishedScoreBefore.toFixed(0)} to{" "}
        {adjustment.publishedScoreAfter.toFixed(0)} under this asset-specific policy adjustment.
      </p>
    </section>
  );
}

export function CapSection({ card }: { card: SafetyScoreV9CurrentCard }) {
  const cap = card.bindingCap;
  const wrapperLimit = card.scoreTrace.wrapperParentLimit;
  if (!cap && !wrapperLimit) return null;
  return (
    <section className="border-b border-border/40 pb-3" aria-labelledby={`${card.id}-v9-cap`}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <h3 id={`${card.id}-v9-cap`} className="text-sm font-semibold">
          {cap ? "Binding cap" : "Wrapper parent limit"}
        </h3>
      </div>
      {cap ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {cap.reason} Limit {cap.limit.toFixed(0)} / 100.
        </p>
      ) : null}
      {wrapperLimit ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Parent score {wrapperLimit.parentScore.toFixed(0)}; wrapper limit {wrapperLimit.limit.toFixed(0)} / 100
          {" "}using {humanizeSafetyScoreV9Value(wrapperLimit.treatment).toLowerCase()} treatment.
        </p>
      ) : null}
    </section>
  );
}
