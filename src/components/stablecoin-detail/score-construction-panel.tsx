"use client";

import { ScanSearch } from "lucide-react";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { SafetyScoreReasonList } from "@/components/stablecoin-detail/safety-score-reason-list";
import type { SafetyScoreV9CurrentCard } from "@shared/types";
import { buildScoreWaterfall, type ScoreWaterfallStep } from "@/lib/safety-score-v9-waterfall";
import { describePartialEvidence } from "@/lib/safety-score-reason-labels";
import { buildSafetyScoreV9Attribution } from "@/lib/stablecoin-safety-score-v9-presentation";
import { cn } from "@/lib/utils";

type ConstructionCard = SafetyScoreV9CurrentCard;

function WaterfallStep({ step }: { step: ScoreWaterfallStep }) {
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
      {step.detail ? (
        <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{step.detail}</p>
      ) : null}
    </li>
  );
}

/**
 * How the pillar bars become the headline number, and what is holding that
 * number down — the arithmetic and its causes read as one thought, folded
 * behind one disclosure inside the Safety Score card at every breakpoint.
 * Reasons render humanized and grouped (D13), three visible per list.
 */
export function ScoreConstructionPanel({ card }: { card: ConstructionCard }) {
  const steps = buildScoreWaterfall(card);
  const { adverseMessages, boundedGroups } = buildSafetyScoreV9Attribution(card);
  const coverageNotice = card.partialEvidence === null ? null : (
    <p className="text-xs text-muted-foreground">
      {card.ratingStatus === "pipeline-gap" ? "No Safety Score is published yet. " : ""}
      {describePartialEvidence(card.partialEvidence).summary}
    </p>
  );
  if (steps.length === 0 && adverseMessages.length === 0 && boundedGroups.length === 0 && coverageNotice === null) return null;

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
            <SafetyScoreReasonList messages={adverseMessages} className="mt-1" />
          </div>
        ) : null}
        {boundedGroups.map((group) => (
          <div key={group.key} className="mt-2.5">
            <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{group.label}</p>
            <SafetyScoreReasonList messages={group.messages} className="mt-1" />
          </div>
        ))}
      </>
    )
    : null;

  return (
    <section className="border-b border-border/40 pb-3" aria-label="How this score is built">
      <ModuleDisclosure label="How this score is built">
        {coverageNotice}
        {steps.length > 0 ? (
          <ul className={cn("space-y-1.5", coverageNotice && "mt-2")}>
            {steps.map((step) => <WaterfallStep key={step.key} step={step} />)}
          </ul>
        ) : null}
        {whyNotHigher ? <div className="mt-3 border-t border-border/40 pt-3">{whyNotHigher}</div> : null}
      </ModuleDisclosure>
    </section>
  );
}
