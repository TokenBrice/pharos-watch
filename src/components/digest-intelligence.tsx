"use client";

import type {
  DigestChangeSummary,
  DigestForwardLookOutcome,
  DigestNextTrigger,
  DigestRiskTapeItem,
  DigestSignalChange,
  DigestStandingCondition,
} from "@shared/types";
import { cn } from "@/lib/utils";

const RISK_TAPE_TONE_CLASSES: Record<DigestRiskTapeItem["tone"], string> = {
  critical: "border-red-500/35 bg-red-500/10 text-red-800 dark:text-red-300",
  warning: "border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  neutral: "border-border/70 bg-muted/40 text-foreground/80",
  positive: "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
};

const OUTCOME_CLASSES: Record<DigestForwardLookOutcome["status"], string> = {
  hit: "border-emerald-500/35 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300",
  missed: "border-border/70 bg-muted/35 text-muted-foreground",
  pending: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  expired: "border-border/70 bg-muted/35 text-muted-foreground",
};

interface DigestIntelligencePanelProps {
  changeSummary?: DigestChangeSummary | null;
  nextTriggers?: DigestNextTrigger[] | null;
  forwardLookOutcomes?: DigestForwardLookOutcome[] | null;
  riskTape?: DigestRiskTapeItem[] | null;
  standingConditions?: DigestStandingCondition[] | null;
  compact?: boolean;
}

function StandingConditionsStrip({ conditions }: { conditions: DigestStandingCondition[] }) {
  return (
    <p className="text-xs leading-relaxed text-muted-foreground">
      <span className="font-mono font-semibold uppercase tracking-[0.16em]">Standing:</span>{" "}
      {conditions.slice(0, 5).map((condition, index) => (
        <span key={condition.stablecoinId ?? condition.symbol}>
          {index > 0 && " · "}
          {condition.symbol} d{condition.ageDays}
          {condition.currentBps != null && ` ${Math.abs(condition.currentBps).toLocaleString()}bps`}
        </span>
      ))}
    </p>
  );
}

function hasChanges(changeSummary: DigestChangeSummary | null | undefined): boolean {
  return !!changeSummary && (
    changeSummary.newSignals.length > 0
    || changeSummary.worsenedSignals.length > 0
    || changeSummary.improvedSignals.length > 0
    || changeSummary.resolvedSignals.length > 0
    || changeSummary.repeatedSignals.length > 0
  );
}

function changeGroup(label: string, changes: DigestSignalChange[]): { label: string; changes: DigestSignalChange[] } | null {
  return changes.length > 0 ? { label, changes: changes.slice(0, 2) } : null;
}

function RiskTape({ items }: { items: DigestRiskTapeItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <div
          key={item.id}
          title={item.detail}
          className={cn(
            "rounded-md border px-2 py-1 font-mono text-[0.68rem] uppercase tracking-[0.16em]",
            RISK_TAPE_TONE_CLASSES[item.tone],
          )}
        >
          <span className="text-muted-foreground/80">{item.label}</span>{" "}
          <span className="font-semibold">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function OutcomeStrip({ outcomes }: { outcomes: DigestForwardLookOutcome[] }) {
  if (outcomes.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Yesterday&apos;s Checks
      </p>
      <div className="flex flex-wrap gap-1.5">
        {outcomes.slice(0, 3).map((outcome) => (
          <span
            key={outcome.id}
            title={outcome.detail}
            className={cn(
              "rounded-full border px-2 py-1 font-mono text-[0.67rem] font-semibold uppercase tracking-[0.15em]",
              OUTCOME_CLASSES[outcome.status],
            )}
          >
            {outcome.status}: {outcome.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function WhatChanged({ changeSummary }: { changeSummary: DigestChangeSummary }) {
  const groups = [
    changeGroup("New", changeSummary.newSignals),
    changeGroup("Worse", changeSummary.worsenedSignals),
    changeGroup("Better", changeSummary.improvedSignals),
    changeGroup("Cleared", changeSummary.resolvedSignals),
  ].filter((group): group is { label: string; changes: DigestSignalChange[] } => group !== null);

  if (groups.length === 0) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        What Changed
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {groups.slice(0, 4).map((group) => (
          <div key={group.label} className="space-y-1">
            <p className="font-mono text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground/85">
              {group.label}
            </p>
            {group.changes.map((change) => (
              <p key={change.id} className="text-xs leading-relaxed text-foreground/80">
                <span className="font-medium">{change.label}</span>
                <span className="text-muted-foreground">, {change.detail}</span>
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function NextTriggers({ triggers }: { triggers: DigestNextTrigger[] }) {
  if (triggers.length === 0) return null;
  return (
    <div className="rounded-lg border border-border/60 bg-background/70 p-3">
      <p className="font-mono text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
        Next Triggers
      </p>
      <ol className="mt-2 space-y-1.5">
        {triggers.slice(0, 3).map((trigger, index) => (
          <li key={trigger.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2 text-xs leading-relaxed text-foreground/82">
            <span className="font-mono text-muted-foreground">{index + 1}.</span>
            <span>
              <span className="font-medium">{trigger.label}</span>
              <span className="text-muted-foreground">, {trigger.thresholdLabel}. {trigger.rationale}</span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function DigestIntelligencePanel({
  changeSummary,
  nextTriggers,
  forwardLookOutcomes,
  riskTape,
  standingConditions,
  compact = false,
}: DigestIntelligencePanelProps) {
  const riskTapeItems = riskTape ?? [];
  const outcomeItems = forwardLookOutcomes ?? [];
  const triggerItems = nextTriggers ?? [];
  const standingItems = standingConditions ?? [];
  const hasRiskTape = riskTapeItems.length > 0;
  const hasOutcomes = outcomeItems.length > 0;
  const hasNextTriggers = triggerItems.length > 0;
  const hasStanding = standingItems.length > 0;
  const hasChangeSummary = hasChanges(changeSummary);

  if (!hasRiskTape && !hasOutcomes && !hasNextTriggers && !hasChangeSummary && !hasStanding) return null;

  if (compact) {
    return (
      <div className="space-y-2">
        {hasRiskTape && <RiskTape items={riskTapeItems} />}
        {hasNextTriggers && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className="font-mono font-semibold uppercase tracking-[0.16em]">Next:</span>{" "}
            {triggerItems[0].detail}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {hasRiskTape && <RiskTape items={riskTapeItems} />}
      {hasStanding && <StandingConditionsStrip conditions={standingItems} />}
      {hasOutcomes && <OutcomeStrip outcomes={outcomeItems} />}
      {hasChangeSummary && changeSummary && <WhatChanged changeSummary={changeSummary} />}
      {hasNextTriggers && <NextTriggers triggers={triggerItems} />}
    </div>
  );
}
