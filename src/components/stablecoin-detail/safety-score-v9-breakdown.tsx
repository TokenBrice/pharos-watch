"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { scoreToGrade } from "@shared/lib/report-card-core";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import type { StablecoinSafetyScoreV9Presentation } from "@/lib/stablecoin-safety-score-v9-presentation";
import { cn } from "@/lib/utils";

type BreakdownRow = NonNullable<
  StablecoinSafetyScoreV9Presentation["pillars"][number]["breakdown"]
>["groups"][number]["rows"][number];

/**
 * Restrained tinting: a bar leaves neutral only when the input is the problem,
 * so a long list stays calm and the eye lands on the weak rows.
 */
const ROW_TONE_FILL_CLASS: Record<BreakdownRow["tone"], string> = {
  neutral: "bg-neutral-500 dark:bg-[#858585]",
  warn: "bg-[var(--severity-moderate)]",
  critical: "bg-[var(--severity-severe)]",
};

const ROW_TONE_SCORE_CLASS: Record<BreakdownRow["tone"], string> = {
  neutral: "text-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  critical: "text-rose-700 dark:text-rose-400",
};

function ComponentScoreBar({ row, nested = false }: { row: BreakdownRow; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const boundedScore = Math.max(0, Math.min(100, row.score));
  const weightLabel = row.weight === null
    ? null
    : `${(row.weight * 100).toFixed(row.weight * 100 < 10 ? 1 : 0)}%`;
  const hasChildren = row.children.length > 0;
  const displayedScore =
    row.score > 0 && row.score < 1 ? "<1" : row.score.toFixed(0);

  const bar = (
    <div className="grid grid-cols-[minmax(5.25rem,6.75rem)_minmax(2.5rem,1fr)_1.75rem_5.25rem] items-center gap-1.5">
      <span className="break-words font-mono text-[11px] uppercase leading-[1.35] tracking-[0.08em] text-muted-foreground">
        {row.label}
      </span>
      <span
        className="h-2.5 overflow-hidden rounded-[3px] border border-neutral-300 bg-neutral-200 dark:border-[#2a2a2d] dark:bg-[#1f1f21]"
        role="img"
        aria-label={`${row.label}: ${displayedScore} out of 100${weightLabel === null ? "" : `, ${weightLabel} weight`}`}
      >
        <span
          className={cn("block h-full rounded-[2px]", ROW_TONE_FILL_CLASS[row.tone])}
          style={{ width: `${boundedScore}%` }}
        />
      </span>
      <span
        className={cn(
          "text-right font-mono text-[11px] font-medium tabular-nums",
          ROW_TONE_SCORE_CLASS[row.tone],
        )}
      >
        {displayedScore}
      </span>
      <span className="text-right font-mono uppercase leading-tight tracking-[0.04em] text-muted-foreground">
        {weightLabel !== null ? <span className="block text-[10px]">· {weightLabel}</span> : null}
        {row.status !== null ? <span className="mt-0.5 block break-words text-[9px]">{row.status}</span> : null}
      </span>
    </div>
  );

  if (!hasChildren) {
    return (
      <div className={cn(nested && "pl-3")}>
        {bar}
        {row.detail !== null ? (
          <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{row.detail}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {bar}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="pharos-focus-ring mt-0.5 flex min-h-6 w-full items-center gap-1 rounded-sm text-left text-[10px] leading-snug text-muted-foreground"
      >
        {row.detail}
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mt-2 space-y-2.5 border-l border-border/40 pl-1">
          {row.children.map((child) => <ComponentScoreBar key={child.key} row={child} nested />)}
        </div>
      ) : null}
    </div>
  );
}

function BreakdownGroupSection({
  group,
}: {
  group: NonNullable<
    StablecoinSafetyScoreV9Presentation["pillars"][number]["breakdown"]
  >["groups"][number];
}) {
  const [tailOpen, setTailOpen] = useState(false);
  return (
    <div>
      {group.label !== null ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border/30 pb-1.5">
          <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-foreground/85">
            {group.label}
          </span>
          {group.score !== null ? (
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {group.score.toFixed(0)} / 100
              {group.weight !== null ? ` · ${(group.weight * 100).toFixed(0)}% pillar weight` : ""}
            </span>
          ) : null}
        </div>
      ) : null}
      <div className={cn("space-y-2.5", group.label !== null && "mt-2.5")}>
        {group.rows.map((row) => <ComponentScoreBar key={row.key} row={row} />)}
      </div>
      {group.tail !== null ? (
        <>
          <button
            type="button"
            onClick={() => setTailOpen((value) => !value)}
            aria-expanded={tailOpen}
            className="pharos-focus-ring mt-2 flex min-h-7 w-full items-center justify-between gap-2 rounded-sm text-[11px] font-medium text-muted-foreground"
          >
            <span>{group.tail.label}</span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 shrink-0 transition-transform", tailOpen && "rotate-180")}
              aria-hidden="true"
            />
          </button>
          {tailOpen ? (
            <div className="mt-2 space-y-2.5">
              {group.tail.rows.map((row) => <ComponentScoreBar key={row.key} row={row} nested />)}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PillarBreakdownDetails({
  breakdown,
}: {
  breakdown: NonNullable<
    StablecoinSafetyScoreV9Presentation["pillars"][number]["breakdown"]
  >;
}) {
  const scoreChanged =
    breakdown.evaluatedScore !== null &&
    breakdown.publishedScore !== null &&
    Math.abs(breakdown.evaluatedScore - breakdown.publishedScore) >= 0.05;
  const contextRowCount = breakdown.context.length + (scoreChanged ? 1 : 0);
  // The exit pillar's route measurements run to six rows of long key/value
  // prose inside an already-nested disclosure. Past two rows the grid is the
  // densest thing on the card, so it collapses; short contexts stay inline.
  const collapseContext = contextRowCount > 2;
  const contextList = (
    <>
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {breakdown.context.map((item) => (
          <div key={item.key} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="min-w-0 break-words text-[11px] text-muted-foreground">{item.label}</dt>
            <dd className="min-w-0 break-words text-right font-mono text-[11px] text-foreground">{item.value}</dd>
          </div>
        ))}
        {scoreChanged ? (
          <div className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="min-w-0 break-words text-[11px] text-muted-foreground">Evaluator to published</dt>
            <dd className="shrink-0 text-right font-mono text-[11px] text-foreground">
              {breakdown.evaluatedScore!.toFixed(1)} to {breakdown.publishedScore!.toFixed(1)}
            </dd>
          </div>
        ) : null}
      </dl>
      {breakdown.exitHighlight !== null ? (
        <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
          Route capacity is specific to the selected executable path. Exchange-wide volume,
          aggregate DEX TVL, and issuer reserves do not prove the same executable amount.
        </p>
      ) : null}
    </>
  );
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
          {breakdown.sectionLabel}
        </span>
        {breakdown.aggregationWeight !== null ? (
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-muted-foreground">
            {(breakdown.aggregationWeight * 100).toFixed(0)}% aggregation weight
          </span>
        ) : null}
      </div>

      {contextRowCount > 0 ? (
        collapseContext ? (
          <details className="group mt-2 border-y border-border/30 py-1.5">
            <summary className="pharos-focus-ring flex min-h-7 cursor-pointer list-none items-center justify-between rounded-sm text-[11px] font-medium text-muted-foreground marker:content-none">
              <span>Measurement detail ({contextRowCount})</span>
              <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
            </summary>
            <div className="pt-2">{contextList}</div>
          </details>
        ) : (
          <div className="mt-2 border-y border-border/30 py-2">{contextList}</div>
        )
      ) : null}

      <div className="mt-2.5 space-y-4">
        {breakdown.groups.map((group) => <BreakdownGroupSection key={group.key} group={group} />)}
      </div>

      {breakdown.alternatives.length > 0 ? (
        <details className="group mt-3 border-t border-border/30 pt-2">
          <summary className="pharos-focus-ring flex min-h-7 cursor-pointer list-none items-center justify-between rounded-sm text-[11px] font-medium text-muted-foreground marker:content-none">
            <span>Other evaluated routes ({breakdown.alternatives.length})</span>
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <ul className="divide-y divide-border/30">
            {breakdown.alternatives.map((route) => (
              <li key={route.key} className="flex min-w-0 items-start justify-between gap-3 py-1.5">
                <span className="min-w-0 break-words text-[11px] leading-[1.35] text-foreground/85">
                  <span className="block">{route.label}</span>
                  {route.detail !== null ? (
                    <span className="mt-0.5 block text-[10px] text-muted-foreground">{route.detail}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                  {route.score === null ? "Not scored" : `V9 route ${route.score.toFixed(0)} / 100`}
                  {route.redundancyCredit !== null
                    ? ` · backup +${route.redundancyCredit.toFixed(1)}`
                    : route.included
                      ? " · evaluated"
                      : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function PillarInputFallback({
  pillar,
}: {
  pillar: StablecoinSafetyScoreV9Presentation["pillars"][number];
}) {
  if (pillar.componentCount === 0) return null;
  return (
    <>
      <div className="flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-[0.1em]">
        <span>Reviewed inputs</span>
        <span className="tabular-nums text-foreground">{pillar.componentCount}</span>
      </div>
      <div
        className="mt-2 flex h-1.5 gap-1"
        role="img"
        aria-label={`${pillar.componentCount} reviewed ${pillar.componentCount === 1 ? "input" : "inputs"}`}
      >
        {pillar.components.map((component) => (
          <span
            key={component.key}
            className="min-w-1 flex-1 rounded-[2px] bg-neutral-500 dark:bg-[#858585]"
          />
        ))}
      </div>
      <ul className="mt-2 grid gap-x-4 sm:grid-cols-2">
        {pillar.components.map((component) => (
          <li
            key={component.key}
            className="flex min-w-0 items-center justify-between gap-2 border-b border-border/30 py-1.5 last:border-b-0"
          >
            <span className="flex min-w-0 items-center gap-2 text-foreground/85">
              <span className="h-1.5 w-1.5 shrink-0 rounded-[2px] bg-emerald-500" aria-hidden="true" />
              <span className="truncate">{component.label}</span>
            </span>
            <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-muted-foreground">
              {component.category}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function SafetyScoreV9PillarRow({
  cardId,
  pillar,
}: {
  cardId: string;
  pillar: StablecoinSafetyScoreV9Presentation["pillars"][number];
}) {
  // All pillars start folded on every viewport (owner decision 2026-08-11,
  // superseding the 2026-08-08 desktop weakest-pillar auto-open): an expanded
  // dimension left the card's left column far taller than the Reserve
  // Composition right column at xl+.
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? false;
  const detailsId = useId();
  const hasDetails = pillar.breakdown !== null || pillar.componentCount > 0 || pillar.reasons.length > 0;
  const scoreGrade = scoreToGrade(pillar.score);
  const gradeMetadata = getSafetyGradeMetadata(scoreGrade);
  return (
    <div className="py-2">
      <button
        type="button"
        onClick={() => hasDetails && setUserOpen(!open)}
        className={cn(
          "pharos-focus-ring block min-h-12 w-full rounded-sm py-1.5 text-left",
          !hasDetails && "cursor-default",
        )}
        aria-expanded={hasDetails ? open : undefined}
        aria-controls={hasDetails ? detailsId : undefined}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-foreground">{pillar.label}</span>
            <span className="mt-0.5 block text-[11px] text-muted-foreground">{pillar.evidenceSummary}</span>
            {pillar.breakdown?.exitHighlight ? (
              <>
                <span className="mt-1 block font-mono text-[10px] text-foreground/85">
                  Primary V9 route: {pillar.breakdown.exitHighlight.primaryRouteLabel}{" "}
                  {pillar.breakdown.exitHighlight.primaryRouteScore.toFixed(1)}
                  {pillar.breakdown.exitHighlight.redundancyCredit > 0
                    ? ` · backup +${pillar.breakdown.exitHighlight.redundancyCredit.toFixed(1)}`
                    : ""}
                </span>
                {pillar.breakdown.exitHighlight.capacityLine !== null ? (
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {pillar.breakdown.exitHighlight.capacityLine}
                  </span>
                ) : null}
              </>
            ) : null}
          </span>
          <span className="whitespace-nowrap font-mono text-sm font-semibold tabular-nums text-foreground">
            {pillar.score === null ? "NR" : `${pillar.score.toFixed(0)} / 100`}
          </span>
          <ScorePill
            label={scoreGrade}
            toneClass={gradeMetadata.pillClassName}
            title="Pillar score band"
            className="min-w-9 justify-center text-[10px] font-semibold"
          />
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
              !hasDetails && "invisible",
            )}
            aria-hidden="true"
          />
        </span>
        <span
          className="mt-2 block h-2.5 overflow-hidden rounded-[3px] border border-neutral-300 bg-neutral-200 dark:border-[#2a2a2d] dark:bg-[#1f1f21]"
          aria-hidden="true"
        >
          {/* A score bar carries its band color so bar and grade pill state the
              same thing (owner ruling 2026-08-11); both read `gradeMetadata`,
              so they cannot drift apart. Composition bars stay neutral. */}
          <span
            className={cn("block h-full rounded-[2px]", pillar.score === null ? "bg-muted-foreground/25" : gradeMetadata.barClassName)}
            style={{ width: `${pillar.score ?? 0}%` }}
          />
        </span>
      </button>
      {hasDetails && open ? (
        <div
          id={detailsId}
          className="pb-2 pl-3 pr-1 pt-1 text-xs leading-relaxed text-muted-foreground"
          data-pillar={cardId}
        >
          {pillar.breakdown !== null ? (
            <PillarBreakdownDetails breakdown={pillar.breakdown} />
          ) : (
            <PillarInputFallback pillar={pillar} />
          )}
          {pillar.reasons.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {pillar.reasons.map((reason) => <li key={reason}>{reason}</li>)}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
