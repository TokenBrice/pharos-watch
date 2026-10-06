import { Award, ShieldCheck } from "lucide-react";
import type { SafetyScoreV9CurrentCard } from "@shared/types";

const WRAPPER_TREATMENT_LABELS: Record<string, string> = {
  "local-facts": "after discounting the wrapper's own reviewed risks",
  "fallback-discount": "after a standard discount because the wrapper's own risks are not fully reviewed",
  "documented-risk-transfer": "after crediting documented risk transfer",
};

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

/**
 * Renders only when a cap determined the published score (#10). A wrapper's
 * parent limit binds through the `parent` cap; a non-binding limit (sUSDe
 * 59 under a 60 limit) is construction detail, not a callout.
 */
export function CapSection({ card }: { card: SafetyScoreV9CurrentCard }) {
  const cap = card.bindingCap;
  if (!cap) return null;
  const wrapperLimit = cap.kind === "parent" ? card.scoreTrace.wrapperParentLimit : null;
  return (
    <section className="border-b border-border/40 pb-3" aria-labelledby={`${card.id}-v9-cap`}>
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-amber-700 dark:text-amber-400" aria-hidden="true" />
        <h3 id={`${card.id}-v9-cap`} className="text-sm font-semibold">
          {wrapperLimit ? "Capped by parent asset" : "Binding cap"}
        </h3>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {wrapperLimit
          ? `The parent asset scores ${wrapperLimit.parentScore.toFixed(0)}; this wrapper is limited to ${wrapperLimit.limit.toFixed(0)} / 100 ${
              WRAPPER_TREATMENT_LABELS[wrapperLimit.treatment] ?? "after wrapper adjustments"
            }.`
          : `${cap.reason} Limit ${cap.limit.toFixed(0)} / 100.`}
      </p>
    </section>
  );
}
