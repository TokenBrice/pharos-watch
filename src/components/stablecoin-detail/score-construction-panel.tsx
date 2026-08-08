"use client";

import { ScanSearch, Sigma } from "lucide-react";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import type {
  SafetyScoreV9CurrentCard,
  SafetyScoreV9PreBreakdownCard,
} from "@shared/types";
import { buildScoreWaterfall, type ScoreWaterfallStep } from "@/lib/safety-score-v9-waterfall";
import { buildSafetyScoreV9Attribution } from "@/lib/stablecoin-safety-score-v9-presentation";
import { cn } from "@/lib/utils";
import { DETAIL_MODULE_TITLE_CLASS } from "@/components/stablecoin-detail/section-title-class";

type ConstructionCard = SafetyScoreV9CurrentCard | SafetyScoreV9PreBreakdownCard;

function WaterfallStep({ step, showHint }: { step: ScoreWaterfallStep; showHint: boolean }) {
  const terminal = step.kind === "published";
  return (
    <li>
      <div className="flex items-baseline justify-between gap-2">
        <p className={cn("min-w-0 text-xs", terminal ? "font-semibold text-foreground" : "text-muted-foreground")}>
          {step.label}
        </p>
        <div className="flex shrink-0 items-baseline gap-2">
          {step.operator ? (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">{step.operator}</span>
          ) : null}
          <span
            className={cn(
              "font-mono text-xs tabular-nums",
              terminal ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            {step.value.toFixed(1)}
          </span>
        </div>
      </div>
      {showHint && step.detail ? (
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{step.detail}</p>
      ) : null}
    </li>
  );
}

/**
 * How the pillar bars become the headline number, and what is holding that
 * number down — the arithmetic and its causes read as one thought, so they
 * render as one module rather than two stacked sections.
 *
 * Lives in the summary rail at `xl+` (`compact`) and inside the Safety Score
 * card below `xl`, the same split `#price` and the access panel use, so the
 * rail's absence on narrow viewports does not lose either half.
 *
 * The per-step hint lines are dropped in the rail: at 22rem they triple the
 * module's height for labels that already read plainly.
 */
export function ScoreConstructionPanel({
  card,
  compact = false,
}: {
  card: ConstructionCard;
  compact?: boolean;
}) {
  const steps = buildScoreWaterfall(card);
  const { adverseMessages, boundedGroups } = buildSafetyScoreV9Attribution(card);
  if (steps.length === 0 && adverseMessages.length === 0 && boundedGroups.length === 0) return null;

  const waterfall = steps.length > 0
    ? (
      <ul className="space-y-1.5">
        {steps.map((step) => <WaterfallStep key={step.key} step={step} showHint={!compact} />)}
      </ul>
    )
    : null;

  const whyNotHigher = adverseMessages.length > 0 || boundedGroups.length > 0
    ? (
      <>
        <div className="flex items-center gap-2">
          <ScanSearch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-xs font-semibold">Why not higher</h3>
        </div>
        {adverseMessages.length > 0 ? (
          <div className="mt-2">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Measured and adverse
            </p>
            <ul className="mt-1 space-y-1 text-[11px] leading-snug text-muted-foreground">
              {adverseMessages.map((message) => <li key={message}>{message}</li>)}
            </ul>
          </div>
        ) : null}
        {boundedGroups.map((group) => (
          <div key={group.key} className="mt-2.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{group.label}</p>
            <ul className="mt-1 space-y-1 text-[11px] leading-snug text-muted-foreground">
              {group.messages.map((message) => <li key={message}>{message}</li>)}
            </ul>
          </div>
        ))}
      </>
    )
    : null;

  if (compact) {
    return (
      <section className="pharos-card-shell overflow-hidden" aria-label="How this score is built">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5">
          <h2 className={DETAIL_MODULE_TITLE_CLASS}>How this score is built</h2>
          <Sigma className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </div>
        {waterfall ? <div className="px-4 pb-4">{waterfall}</div> : null}
        {whyNotHigher ? (
          <div className={cn("px-4 pb-4", waterfall && "border-t border-border/50 pt-4")}>{whyNotHigher}</div>
        ) : null}
      </section>
    );
  }

  // In-flow (below xl) the construction arithmetic is detail, not verdict —
  // it folds behind the standard disclosure; the rail keeps its at-a-glance
  // expanded copy at xl+.
  return (
    <section className="border-b border-border/40 pb-3 xl:hidden" aria-label="How this score is built">
      <ModuleDisclosure label="How this score is built">
        {waterfall ? <div className="mt-2">{waterfall}</div> : null}
        {whyNotHigher ? <div className="mt-3 border-t border-border/40 pt-3">{whyNotHigher}</div> : null}
      </ModuleDisclosure>
    </section>
  );
}
