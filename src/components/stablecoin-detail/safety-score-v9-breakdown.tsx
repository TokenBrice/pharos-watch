"use client";

import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { SafetyScoreReasonList } from "@/components/stablecoin-detail/safety-score-reason-list";
import { SAFETY_BREAKDOWN_ROW_TONE_TEXT_CLASSES } from "@shared/lib/classification";
import { scoreToGrade } from "@shared/lib/report-card-core";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { formatLocalAuthorityExposure, formatLocalAuthorityShare, formatPricedUnknown } from "@/lib/safety-score-reason-labels";
import type { StablecoinSafetyScoreV9Presentation } from "@/lib/stablecoin-safety-score-v9-presentation";
import { cn } from "@/lib/utils";
import { FigureLeadText } from "./figure-lead-text";

type BreakdownRow = NonNullable<
  StablecoinSafetyScoreV9Presentation["pillars"][number]["breakdown"]
>["groups"][number]["rows"][number];

/**
 * Where a pillar's evidence board renders on the detail page: at every width,
 * only below `xl` (its only content is an in-flow twin of a rail card), or not
 * at all. A pillar row links to its board only where the board exists.
 */
export type PillarEvidenceBoardVisibility = "all" | "below-xl" | "none";

export type PillarEvidenceAnchors = Record<
  StablecoinSafetyScoreV9Presentation["pillars"][number]["key"],
  PillarEvidenceBoardVisibility
>;

/**
 * Restrained tinting: a bar leaves neutral only when the input is the problem,
 * so a long list stays calm and the eye lands on the weak rows.
 */
const ROW_TONE_FILL_CLASS: Record<BreakdownRow["tone"], string> = {
  neutral: "bg-meter-neutral",
  warn: "bg-[var(--severity-moderate)]",
  critical: "bg-[var(--severity-severe)]",
};

const ROW_TONE_SCORE_CLASS: Record<BreakdownRow["tone"], string> = {
  neutral: "text-foreground",
  warn: SAFETY_BREAKDOWN_ROW_TONE_TEXT_CLASSES.warn,
  critical: SAFETY_BREAKDOWN_ROW_TONE_TEXT_CLASSES.critical,
};

const TRACK_CLASS =
  "overflow-hidden rounded-xs border border-meter-track-border bg-meter-track";
/** Unavailable: an empty dashed outline (as in the pillar strips), never an empty solid track that reads as zero. */
const UNAVAILABLE_TRACK_CLASS = "rounded-xs border border-dashed border-muted-foreground/50";
/**
 * Diagnostic Control input (outside the eligible set): the dashed track and
 * faded fill of the Control strip's diagnostic grammar, so a weak bar that does
 * not set the score keeps its hue without competing with the limiting row.
 */
const DIAGNOSTIC_TRACK_CLASS =
  "overflow-hidden rounded-xs border border-dashed border-muted-foreground/50 bg-muted/60";

function ComponentScoreBar({ row, nested = false }: { row: BreakdownRow; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const childrenId = useId();
  const boundedScore = row.score === null ? null : Math.max(0, Math.min(100, row.score));
  const weightLabel = row.weight === null
    ? null
    : `${(row.weight * 100).toFixed(row.weight * 100 < 10 ? 1 : 0)}%`;
  const hasChildren = row.children.length > 0;
  const displayedScore = row.score === null ? "—" :
    row.score > 0 && row.score < 1 ? "<1" : row.score.toFixed(0);

  const diagnostic = row.role === "diagnostic";
  // A fold member has no role tag, so a bare row gives its status column back to the bar.
  const compactStatus = nested && row.status === null && weightLabel === null;
  const bar = (
    <div className={cn(
      "grid items-center gap-1.5",
      compactStatus
        ? "grid-cols-[minmax(5.25rem,6.75rem)_minmax(2.5rem,1fr)_1.75rem]"
        : "grid-cols-[minmax(5.25rem,6.75rem)_minmax(2.5rem,1fr)_1.75rem_5.25rem]",
    )}>
      <span className="pharos-label break-words leading-[1.35]">
        {row.label}
      </span>
      <span
        className={cn("h-2.5", boundedScore === null ? UNAVAILABLE_TRACK_CLASS : diagnostic ? DIAGNOSTIC_TRACK_CLASS : TRACK_CLASS)}
        role="img"
        aria-label={`${row.label}: ${row.score === null ? row.status ?? "Not scored" : `${displayedScore} out of 100`}${weightLabel === null ? "" : `, ${weightLabel} effective weight`}`}
      >
        {boundedScore === null ? null : (
          <span
            className={cn("block h-full rounded-xs", ROW_TONE_FILL_CLASS[row.tone], diagnostic && "opacity-45")}
            style={{ width: `${boundedScore}%` }}
          />
        )}
      </span>
      <span
        className={cn(
          "text-right font-mono text-2xs font-medium tabular-nums",
          // A diagnostic's tone stays on its faded bar; its number must not
          // out-shout the limiting input that sets the pillar.
          diagnostic ? "text-muted-foreground" : ROW_TONE_SCORE_CLASS[row.tone],
        )}
      >
        {displayedScore}
      </span>
      {compactStatus ? null : <span className="pharos-label flex flex-col items-end text-right leading-tight">
        {/* A fold holds one role, so its members leave the tag to the fold row. */}
        {!nested && (row.role === "limiting" || row.role === "diagnostic") ? <ControlRoleTag role={row.role} size="compact" /> : null}
        {weightLabel !== null ? <span className="block text-3xs">· {weightLabel}</span> : null}
        {row.status !== null ? <span className="mt-0.5 block break-words text-3xs">{row.status}</span> : null}
      </span>}
    </div>
  );

  if (!hasChildren) {
    return (
      <div className={cn(nested && "pl-3")}>
        {bar}
        {row.detail !== null ? (
          <p className="mt-0.5 text-3xs leading-snug text-muted-foreground">{row.detail}</p>
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
        aria-controls={childrenId}
        className="pharos-focus-ring mt-0.5 flex min-h-6 w-full items-center gap-1 rounded-sm text-left text-3xs leading-snug text-muted-foreground"
      >
        {/* The visible summary names no subject; the hidden lead says what the toggle opens. */}
        <span className="sr-only">{`${row.children.length} members of ${row.label}: `}</span>
        {row.detail}
        <ChevronDown className={cn("h-3 w-3 shrink-0 transition-transform motion-reduce:transition-none", open && "rotate-180")} aria-hidden="true" />
      </button>
      {open ? (
        <div id={childrenId} className="mt-2 space-y-2.5 border-l border-border/40 pl-1">
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
          <span className="pharos-label text-foreground/85">
            {group.label}
          </span>
          {group.score !== null ? (
            <span className="font-mono text-2xs tabular-nums text-muted-foreground">
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
            className="pharos-focus-ring mt-2 flex min-h-7 w-full items-center justify-between gap-2 rounded-sm text-2xs font-medium text-muted-foreground"
          >
            <span>{group.tail.label}</span>
            <ChevronDown
              className={cn("h-3.5 w-3.5 shrink-0 transition-transform motion-reduce:transition-none", tailOpen && "rotate-180")}
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
            <dt className="min-w-0 break-words text-2xs text-muted-foreground">{item.label}</dt>
            <dd className="min-w-0 break-words text-right text-2xs text-foreground"><FigureLeadText text={item.value} /></dd>
          </div>
        ))}
        {scoreChanged ? (
          <div className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="min-w-0 break-words text-2xs text-muted-foreground">Evaluator to published</dt>
            <dd className="shrink-0 text-right font-mono text-2xs text-foreground">
              {breakdown.evaluatedScore!.toFixed(1)} to {breakdown.publishedScore!.toFixed(1)}
            </dd>
          </div>
        ) : null}
      </dl>
      {breakdown.exitHighlight !== null ? (
        <p className="mt-2 text-3xs leading-snug text-muted-foreground">
          Route capacity is specific to the selected executable path. Exchange-wide volume,
          aggregate DEX TVL, and issuer reserves do not prove the same executable amount.
        </p>
      ) : null}
    </>
  );
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="pharos-label">
          {breakdown.sectionLabel}
        </span>
        {breakdown.aggregationWeight !== null ? (
          <span className="pharos-label">
            {(breakdown.aggregationWeight * 100).toFixed(0)}% aggregation weight
          </span>
        ) : null}
      </div>

      {contextRowCount > 0 ? (
        collapseContext ? (
          <details className="group/measure mt-2 border-y border-border/30 py-1.5">
            <summary className="pharos-focus-ring flex min-h-7 cursor-pointer list-none items-center justify-between rounded-sm text-2xs font-medium text-muted-foreground marker:content-none">
              <span>Measurement detail ({contextRowCount})</span>
              <ChevronDown className="h-3.5 w-3.5 transition-transform motion-reduce:transition-none group-open/measure:rotate-180" aria-hidden="true" />
            </summary>
            <div className="pt-2">{contextList}</div>
          </details>
        ) : (
          <div className="mt-2 border-y border-border/30 py-2">{contextList}</div>
        )
      ) : null}

      {/* Read before the rows: it explains how the diagnostic rows below count. */}
      {breakdown.note !== null ? (
        <p className="mt-2 text-3xs leading-snug text-muted-foreground">{breakdown.note}</p>
      ) : null}

      <div className="mt-2.5 space-y-4">
        {breakdown.groups.map((group) => <BreakdownGroupSection key={group.key} group={group} />)}
      </div>

      {breakdown.alternatives.length > 0 ? (
        <details className="group/routes mt-3 border-t border-border/30 pt-2">
          <summary className="pharos-focus-ring flex min-h-7 cursor-pointer list-none items-center justify-between rounded-sm text-2xs font-medium text-muted-foreground marker:content-none">
            <span>Other evaluated routes ({breakdown.alternatives.length})</span>
            <ChevronDown
              className="h-3.5 w-3.5 transition-transform motion-reduce:transition-none group-open/routes:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <ul className="divide-y divide-border/30">
            {breakdown.alternatives.map((route) => (
              <li key={route.key} className="flex min-w-0 items-start justify-between gap-3 py-1.5">
                <span className="min-w-0 break-words text-2xs leading-[1.35] text-foreground/85">
                  <span className="block">{route.label}</span>
                  {route.detail !== null ? (
                    <span className="mt-0.5 block text-3xs text-muted-foreground">{route.detail}</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-right font-mono text-3xs text-muted-foreground">
                  {route.score === null ? "Not scored" : `V10 route ${route.score.toFixed(0)} / 100`}
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
      <div className="pharos-label flex items-center justify-between gap-3">
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
            className="min-w-1 flex-1 rounded-xs bg-meter-neutral"
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
              <span className="h-1.5 w-1.5 shrink-0 rounded-xs bg-state-positive-solid" aria-hidden="true" />
              <span className="truncate">{component.label}</span>
            </span>
            <span className="pharos-label shrink-0">
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
  evidenceVisibility = "all",
}: {
  cardId: string;
  pillar: StablecoinSafetyScoreV9Presentation["pillars"][number];
  /** Defaults to `"all"`: a caller that does not know the page's boards keeps the link. */
  evidenceVisibility?: PillarEvidenceBoardVisibility;
}) {
  // All pillars start folded on every viewport (owner decision 2026-08-11).
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? false;
  const detailsId = useId();
  const exposure = pillar.key === "control" ? pillar.localAuthorityExposure ?? null : null;
  const hasDetails = pillar.breakdown !== null || pillar.componentCount > 0 || pillar.reasons.length > 0 || exposure !== null;
  const scoreGrade = pillar.score === null ? null : scoreToGrade(pillar.score);
  const gradeMetadata = getSafetyGradeMetadata(scoreGrade);
  // A priced unknown keeps the score column's shape ("Unknown" where a measured
  // pillar reads "35 / 100") and names its cause and stand-in score beneath the
  // label, so the assumption is never drawn or graded like a measurement.
  const pricedNote = pillar.pricedUnknown ? formatPricedUnknown(pillar.pricedUnknown) : null;
  const unknownNote = pricedNote ? `${pricedNote.charAt(0).toUpperCase()}${pricedNote.slice(1)}` : null;
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
            <span
              className="mt-0.5 block text-2xs text-muted-foreground"
              title={pillar.evidenceDescription ?? undefined}
            >
              {pillar.evidenceSummary}
            </span>
            {unknownNote ? (
              <span className="mt-1 block text-2xs text-foreground/85">{unknownNote}</span>
            ) : null}
            {exposure ? (
              <span className="mt-1 block text-2xs text-foreground/85">{formatLocalAuthorityExposure(exposure)}</span>
            ) : null}
            {pillar.breakdown?.exitHighlight ? (
              <span className="mt-1 block text-2xs text-foreground/85">
                Best exit: {pillar.breakdown.exitHighlight.venueLabel}
                {pillar.breakdown.exitHighlight.capacityLine !== null ? ` · ${pillar.breakdown.exitHighlight.capacityLine}` : ""}
                {pillar.breakdown.exitHighlight.redundancyCredit > 0
                  ? ` · backup route +${pillar.breakdown.exitHighlight.redundancyCredit.toFixed(0)}`
                  : ""}
              </span>
            ) : null}
          </span>
          <span className={cn(
            "whitespace-nowrap font-mono text-sm font-semibold tabular-nums",
            unknownNote ? "text-muted-foreground" : "text-foreground",
          )}>
            {pillar.score === null ? unknownNote ? "Unknown" : "Not scored" : `${pillar.score.toFixed(0)} / 100`}
          </span>
          {unknownNote === null ? <ScorePill
            label={scoreGrade === null ? "Excluded" : scoreGrade}
            toneClass={gradeMetadata.pillClassName}
            title="Pillar score band"
            className="min-w-9 justify-center text-3xs font-semibold"
          /> : null}
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-180",
              !hasDetails && "invisible",
            )}
            aria-hidden="true"
          />
        </span>
      </button>
      {/* Outside the button so its label does not pad the button's name. A
          score bar carries its band color so bar and grade pill state the
          same thing (owner ruling 2026-08-11); both read `gradeMetadata`, so
          they cannot drift apart. A pillar without a score draws the dashed
          unavailable track, never an empty bar that reads as zero. */}
      {/* The bar and the evidence jump share one row, so the link adds no
          line of its own under every pillar. */}
      <div className="mt-0.5 flex items-center gap-2">
      <span
        role="img"
        aria-label={pillar.score === null
          ? `${pillar.label}: ${pricedNote ? `unknown, ${pricedNote}` : "score unavailable"}`
          : `${pillar.label}: ${pillar.score.toFixed(0)} out of 100`}
        className={cn("block h-2.5 min-w-0 flex-1", pillar.score === null ? UNAVAILABLE_TRACK_CLASS : TRACK_CLASS)}
      >
        {pillar.score === null ? null : (
          <span
            className={cn("block h-full rounded-xs", gradeMetadata.barClassName)}
            style={{ width: `${Math.max(0, Math.min(100, pillar.score))}%` }}
          />
        )}
      </span>
      {evidenceVisibility === "none" ? null : (
          <a
            href={`#${pillar.key}-evidence`}
            className={cn(
              "pharos-focus-ring shrink-0 rounded-sm px-1 py-1 text-2xs text-muted-foreground underline decoration-dashed underline-offset-2 hover:text-foreground",
              evidenceVisibility === "below-xl" && "xl:hidden",
            )}
            aria-label={`${pillar.label} evidence`}
          >
            Evidence ↓
          </a>
      )}
      </div>
      {hasDetails && open ? (
        <div
          id={detailsId}
          className="pb-2 pl-3 pr-1 pt-1 text-xs leading-relaxed text-muted-foreground"
          data-pillar={cardId}
        >
          {exposure ? (
            <div className="mb-3">
              <p className="pharos-label">Local admins by priced loss</p>
              <ul>
                {exposure.slices.map((slice) => (
                  <li
                    key={slice.deploymentLabel}
                    className="flex min-w-0 items-baseline justify-between gap-3 border-b border-border/30 py-1 last:border-b-0"
                  >
                    <span className="min-w-0 break-words">{slice.deploymentLabel}</span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {Number(slice.quality.toFixed(1))} on {formatLocalAuthorityShare(slice.share)}
                    </span>
                  </li>
                ))}
              </ul>
              {exposure.moreCount > 0 ? (
                <p>+{exposure.moreCount} more {exposure.moreCount === 1 ? "deployment" : "deployments"}</p>
              ) : null}
            </div>
          ) : null}
          {pillar.breakdown !== null ? (
            <PillarBreakdownDetails breakdown={pillar.breakdown} />
          ) : (
            <PillarInputFallback pillar={pillar} />
          )}
          {pillar.reasons.length > 0 ? <SafetyScoreReasonList messages={pillar.reasons} className="mt-2 text-xs" /> : null}
        </div>
      ) : null}
    </div>
  );
}
