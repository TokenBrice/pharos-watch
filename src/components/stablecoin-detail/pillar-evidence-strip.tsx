import type { ReactNode } from "react";
import { ControlRoleGlyph, ControlRoleTag } from "@/components/stablecoin-detail/control-role-tag";
import { MechanismReviewPanel } from "@/components/stablecoin-detail/mechanism-review-panel";
import { ModuleDisclosure } from "@/components/stablecoin-detail/module-disclosure";
import { ScorePill } from "@/components/stablecoin-detail/score-pill";
import { SECTION_SCROLL_MT } from "@/components/stablecoin-detail/section-title-class";
import type { ControlPostureView } from "@/lib/control-posture";
import type { MechanismReviewView } from "@/lib/mechanism-review";
import type {
  BackingStripView,
  ControlStripComponent,
  ControlStripComponentGroup,
  ControlStripView,
  ExitStripView,
  PillarStripHeadline,
  PillarStripTone,
} from "@/lib/pillar-evidence-strips";
import { getSafetyGradeMetadata } from "@/lib/report-card-ui";
import { cn } from "@/lib/utils";
import { CONTROL_COMPONENT_ROLE_LABELS } from "@shared/lib/classification";
import { formatV9PresentationUsd } from "@shared/lib/format";

/**
 * A Safety Score pillar's header strip: the kicker heading, the published
 * grade, score and bar, then the pillar's decomposition drawn at the density
 * of the score card's pillar rows. Bars are CSS, never SVG, to keep the
 * static HTML light. Unavailable values render dashed or "–", never as zero.
 *
 * The strip's container owns the board's provenance anchor
 * (`#mechanism-review`, `#control-posture`), so a jump lands on the heading
 * with the bars in view rather than on the provenance line beneath them.
 */

type PillarEvidenceStripProps =
  | { pillar: "backing"; view: BackingStripView | null } & StripCommonProps
  | { pillar: "exit"; view: ExitStripView | null } & StripCommonProps
  | { pillar: "control"; view: ControlStripView | null } & StripCommonProps;

interface StripCommonProps {
  headingId: string;
  title: string;
  mechanismReview?: MechanismReviewView | null;
  controlPosture?: ControlPostureView | null;
}

const KICKER_CLASS = "pharos-kicker";
const TRACK_CLASS =
  "relative block h-2 overflow-hidden rounded-[3px] border border-neutral-300 bg-neutral-200 dark:border-[#2a2a2d] dark:bg-[#1f1f21]";
/** Unavailable: an empty dashed outline, never an empty solid track that reads as zero. */
const UNAVAILABLE_TRACK_CLASS = "relative block h-2 rounded-[3px] border border-dashed border-muted-foreground/50";
const TONE_FILL_CLASS: Record<PillarStripTone, string> = {
  neutral: "bg-neutral-500 dark:bg-[#858585]",
  warn: "bg-[var(--severity-moderate)]",
  critical: "bg-[var(--severity-severe)]",
};
const TONE_TEXT_CLASS: Record<PillarStripTone, string> = {
  neutral: "text-foreground",
  warn: "text-amber-700 dark:text-amber-400",
  critical: "text-rose-700 dark:text-rose-400",
};
const HATCHED_FILL_CLASS =
  "bg-muted-foreground/45 bg-[image:repeating-linear-gradient(135deg,var(--color-card)_0_1.5px,transparent_1.5px_4px)]";
const DIAGNOSTIC_FILL_CLASS = "bg-muted-foreground/35";
/** The pattern channel for "limiting": an outline, paired with the `ControlRoleGlyph` beside the score. */
const LIMITING_TRACK_CLASS = "ring-2 ring-foreground/80 ring-offset-1 ring-offset-background";
/**
 * Rows top-align: a wrapped label or a caption line grows its own row
 * downward, so bars in neighbouring columns stay level (syrupUSDC's
 * "Unverified · scored 35" custody row).
 */
const ROW_GRID_CLASS = "grid grid-cols-[minmax(0,10rem)_minmax(3rem,1fr)_4.25rem] content-start items-start gap-x-2.5";
/** One label line (`text-xs` × `leading-snug` = 16.5 px): the bar and score centre on the label's first line. */
const FIRST_LINE_CLASS = "flex h-[1.03125rem] items-center";
const LIST_GRID_CLASS = "grid gap-x-8 gap-y-2.5 @2xl/strip:grid-cols-2 @5xl/strip:grid-cols-3";
const CAPTION_CLASS = "col-span-3 text-[11px] leading-snug text-muted-foreground";
const PROVENANCE_ROW_CLASS =
  "flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 pt-2 text-[11px] text-muted-foreground";
const DISCLOSURE_SUMMARY_CLASS = "min-h-9 text-[11px] lg:min-h-7";
const FIGURE_CLASS = "font-mono tabular-nums";
/** Evaluated routes the pillar did not count, listed under "none qualifies" before the rest collapse to a count. */
const EXCLUDED_ROUTES_SHOWN = 3;

function formatScore(score: number | null): string {
  if (score === null) return "–";
  return score > 0 && score < 1 ? "<1" : score.toFixed(0);
}

function formatDelta(delta: number): string {
  return `${delta < 0 ? "−" : "+"}${Math.abs(delta).toFixed(1)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function Bar({
  score,
  label,
  fillClassName,
  outlined = false,
  dashed = false,
  range = null,
  className,
}: {
  score: number | null;
  label: string;
  fillClassName: string;
  outlined?: boolean;
  dashed?: boolean;
  /** Optional upper end, drawn as a lighter band from `score` to it. */
  range?: number | null;
  className?: string;
}) {
  const width = score === null ? null : Math.max(0, Math.min(100, score));
  const upper = range === null || width === null ? null : Math.max(width, Math.min(100, range));
  return (
    <span
      role="img"
      aria-label={label}
      className={cn(
        width === null || dashed ? UNAVAILABLE_TRACK_CLASS : TRACK_CLASS,
        outlined && LIMITING_TRACK_CLASS,
        className,
      )}
    >
      {width === null ? null : (
        <span className={cn("absolute inset-y-0 left-0 rounded-[2px]", fillClassName)} style={{ width: `${width}%` }} />
      )}
      {upper !== null && width !== null && upper > width ? (
        <span
          className="absolute inset-y-0 rounded-[2px] bg-muted-foreground/15"
          style={{ left: `${width}%`, width: `${upper - width}%` }}
        />
      ) : null}
    </span>
  );
}

function StripHeader({
  headingId,
  title,
  view,
  pillarLabel,
}: {
  headingId: string;
  title: string;
  view: PillarStripHeadline;
  pillarLabel: string;
}) {
  const grade = getSafetyGradeMetadata(view.grade);
  const scoreText = view.score === null ? "excluded from the aggregate" : `${formatScore(view.score)} of 100, grade ${view.grade}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-2">
      <h2 id={headingId} className={cn(KICKER_CLASS, "shrink-0")}>{title}</h2>
      <ScorePill
        label={view.grade ?? "Excluded"}
        toneClass={grade.pillClassName}
        title="Pillar grade"
        className="min-w-9 justify-center text-[11px] font-semibold"
      />
      <span aria-hidden="true" className="pharos-numeric text-sm font-semibold tabular-nums text-foreground">
        {formatScore(view.score)}
        <span className="text-xs font-normal text-muted-foreground">/100</span>
      </span>
      <Bar
        score={view.score}
        label={`${pillarLabel} pillar score: ${scoreText}`}
        fillClassName={grade.barClassName}
        className="min-w-24 flex-1"
      />
    </div>
  );
}

/**
 * One decomposition row: name over a muted detail line, bar, then the score
 * (with the role glyph on Control rows). The visible cells are aria-hidden;
 * the bar's aria-label carries the whole row.
 */
function ScoreRow({
  label,
  detail,
  value,
  valueClassName,
  marker,
  bar,
  caption,
}: {
  label: ReactNode;
  detail?: string | null;
  value: string;
  valueClassName?: string;
  marker?: ReactNode;
  bar: ReactNode;
  caption?: ReactNode;
}) {
  return (
    <li className={ROW_GRID_CLASS}>
      <span aria-hidden="true" className="min-w-0 break-words text-xs leading-snug text-foreground">
        {label}
        {detail ? <span className="block text-[11px] text-muted-foreground">{detail}</span> : null}
      </span>
      <span className={cn(FIRST_LINE_CLASS, "flex-col items-stretch justify-center")}>{bar}</span>
      <span
        aria-hidden="true"
        className={cn(
          FIRST_LINE_CLASS,
          "justify-end gap-1 font-mono text-[11px] font-medium tabular-nums",
          valueClassName ?? "text-foreground",
        )}
      >
        {marker}
        {value}
      </span>
      {caption ? <span aria-hidden="true" className={CAPTION_CLASS}>{caption}</span> : null}
    </li>
  );
}

/** The Backing strip's provenance row; its anchor `#mechanism-review` sits on the strip container. */
function MechanismReviewRow({ review }: { review: MechanismReviewView }) {
  return (
    <div className={PROVENANCE_ROW_CLASS}>
      <span>
        Mechanism reviewed <span className="pharos-numeric">{review.reviewedAt}</span>
        {" · "}
        {review.sources.length} {review.sources.length === 1 ? "source" : "sources"}
      </span>
      <ModuleDisclosure
        label="Review notes & sources"
        count={review.sources.length}
        className="open:basis-full"
        summaryClassName={DISCLOSURE_SUMMARY_CLASS}
      >
        <div className="pb-1 pt-2">
          <MechanismReviewPanel review={review} />
        </div>
      </ModuleDisclosure>
    </div>
  );
}

/**
 * The Control strip's descriptive posture and its notes; its anchor
 * `#control-posture` sits on the strip container. The chip stays neutral:
 * posture is a classification, not a Safety Score input, so it takes no
 * state hue.
 */
function ControlPostureRow({ posture }: { posture: ControlPostureView }) {
  return (
    <div className={PROVENANCE_ROW_CLASS}>
      <span className="inline-flex items-center gap-2">
        Control posture
        <span
          title="Descriptive classification; not a Safety Score input"
          className="inline-flex items-center rounded-md border border-border bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-foreground"
        >
          {posture.label}
        </span>
      </span>
      {posture.details.length > 0 ? (
        <ModuleDisclosure
          label="Posture notes"
          className="open:basis-full"
          summaryClassName={DISCLOSURE_SUMMARY_CLASS}
        >
          <div className="max-w-[75ch] space-y-2 pb-1 pt-2 text-xs leading-relaxed text-muted-foreground">
            {posture.details.map((detail) => <p key={detail}>{detail}</p>)}
          </div>
        </ModuleDisclosure>
      ) : null}
    </div>
  );
}

function BackingBody({ view, review }: { view: BackingStripView; review: MechanismReviewView | null }) {
  return (
    <>
      {view.groups.length > 0 ? (
        <ul aria-label="Backing groups" className={LIST_GRID_CLASS}>
          {view.groups.map((group) => (
            <ScoreRow
              key={group.key}
              label={group.label}
              detail={`${percent(group.weight)} weight`}
              value={formatScore(group.score)}
              valueClassName={TONE_TEXT_CLASS[group.tone]}
              bar={(
                <Bar
                  score={group.score}
                  label={`${group.label}: ${group.score === null ? "not scored" : `${formatScore(group.score)} of 100`}, ${percent(group.weight)} of the Backing pillar`}
                  fillClassName={TONE_FILL_CLASS[group.tone]}
                />
              )}
            />
          ))}
        </ul>
      ) : null}
      {view.mechanism.length > 0 ? (
        <div className="space-y-1.5">
          <p className="text-[11px] font-medium text-muted-foreground">Mechanism components</p>
          <ul aria-label="Mechanism component scores" className={LIST_GRID_CLASS}>
            {view.mechanism.map((component) => {
              const unverified = component.state === "unverified";
              const stateCaption = component.score === null
                ? "Not scored"
                : unverified
                  ? `Unverified · scored ${formatScore(component.score)}`
                  : component.state === "stale"
                    ? `Stale · scored ${formatScore(component.score)}`
                    : null;
              return (
                <ScoreRow
                  key={component.key}
                  label={component.label}
                  value={formatScore(component.score)}
                  valueClassName={unverified ? "text-muted-foreground" : TONE_TEXT_CLASS[component.tone]}
                  bar={(
                    <Bar
                      score={component.score}
                      label={`${component.label}: ${stateCaption ?? `${formatScore(component.score)} of 100`}`}
                      fillClassName={unverified ? HATCHED_FILL_CLASS : TONE_FILL_CLASS[component.tone]}
                    />
                  )}
                  caption={stateCaption}
                />
              );
            })}
          </ul>
        </div>
      ) : null}
      {review ? <MechanismReviewRow review={review} /> : null}
    </>
  );
}

/**
 * Route against pillar, as arithmetic. The route's number is the value the
 * Exit pillar counted for it, which can differ from the Redemption module's
 * standalone route score (USDe: 74 here, 75 there) or stand where that score
 * is not rated (ZSD), so the line names it as the pillar-counted value.
 */
function ExitBody({ view }: { view: ExitStripView }) {
  const { route, backup, capacity, stressRequest, excludedRoutes } = view;
  const capacityText = capacity
    ? `${formatV9PresentationUsd(capacity.executableUsd)} of ${formatV9PresentationUsd(capacity.requestedNotionalUsd)} at ≤${capacity.maxCostBps.toFixed(0)} bps`
    : route === null
      ? "No qualifying route"
      : "Not measured";
  // One flag drives the label, the percent and the tone, so "100%" never sits
  // beside "below the capacity threshold" or an amber bar. A partial fill is
  // the best route available below the request (EURC: $887k of $25m), and
  // its percent rounds down so it never reads 100%.
  const routeQualifier = capacity === null
    ? ""
    : capacity.qualified
      ? " (capacity-qualified)"
      : " (best available, below the capacity threshold)";
  const capacityPercent = capacity === null
    ? "–"
    : capacity.qualified
      ? "100%"
      : capacity.completionRatio > 0 && capacity.completionRatio < 0.01
        ? "<1%"
        : `${Math.min(99, Math.floor(capacity.completionRatio * 100))}%`;
  const capacityTone = capacity?.tone ?? "neutral";
  const exitTotal = (
    <span className="font-medium text-foreground">
      Exit <span className={FIGURE_CLASS}>{formatScore(view.score)}</span>
    </span>
  );
  const shownExcluded = excludedRoutes.slice(0, EXCLUDED_ROUTES_SHOWN);
  const hiddenExcluded = excludedRoutes.length - shownExcluded.length;
  return (
    <ul aria-label="Exit route" className="grid gap-x-8 gap-y-2.5 @2xl/strip:grid-cols-2">
      <li className="min-w-0 space-y-0.5 text-xs leading-snug">
        {route === null ? (
          <>
            <p>
              <span className="text-muted-foreground">Selected route </span>
              <span className="font-medium text-foreground">none qualifies</span>
            </p>
            <p className="text-[11px] text-muted-foreground">
              No route qualifies
              {stressRequest ? (
                <>
                  {" at "}
                  <span className={FIGURE_CLASS}>{formatV9PresentationUsd(stressRequest.requestedNotionalUsd)}</span>
                  {" "}
                  <span className={FIGURE_CLASS}>≤{stressRequest.maxCostBps.toFixed(0)} bps</span>
                </>
              ) : null}
              {" → "}
              {exitTotal}
            </p>
            {shownExcluded.map((excluded) => (
              <p key={excluded.key} className="text-[11px] text-muted-foreground">
                {excluded.label}
                {excluded.score === null ? null : (
                  <>
                    {" · scored "}
                    <span className={FIGURE_CLASS}>{formatScore(excluded.score)}</span>
                  </>
                )}
                {" · not counted: "}
                {excluded.reason.charAt(0).toLowerCase()}{excluded.reason.slice(1)}
              </p>
            ))}
            {hiddenExcluded > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                +<span className={FIGURE_CLASS}>{hiddenExcluded}</span> more {hiddenExcluded === 1 ? "route" : "routes"} not counted
              </p>
            ) : null}
          </>
        ) : (
          <>
            <p>
              <span className="text-muted-foreground">Selected route{routeQualifier} </span>
              <span className="font-medium text-foreground">{route.label}</span>
            </p>
            {/* The equation reconciles route and pillar without prose:
                pillar-counted route value + backup credit = the published Exit score. */}
            <p className="text-[11px] text-muted-foreground">
              Pillar-counted route value <span className={FIGURE_CLASS}>{formatScore(route.score)}</span>
              {backup ? (
                <>
                  {" + backup "}
                  <span className={FIGURE_CLASS}>{backup.bonus.toFixed(1)}</span>
                </>
              ) : null}
              {" = "}
              {exitTotal}
              {backup ? ` · backup: ${backup.label}` : null}
            </p>
          </>
        )}
      </li>
      <ScoreRow
        label="Capacity"
        value={capacityPercent}
        valueClassName={TONE_TEXT_CLASS[capacityTone]}
        bar={(
          <Bar
            score={capacity ? (capacity.qualified ? 100 : capacity.completionRatio * 100) : null}
            label={`Executable capacity: ${capacityText}${capacity && !capacity.qualified ? `, ${capacityPercent} of the request, below the capacity threshold` : ""}`}
            fillClassName={TONE_FILL_CLASS[capacityTone]}
          />
        )}
        caption={capacityText}
      />
    </ul>
  );
}

function ControlComponentRow({ component, scope }: { component: ControlStripComponent; scope: string | null }) {
  const muted = component.role === "diagnostic" || component.role === "excluded";
  const name = scope ? `${component.label}, ${scope}` : component.label;
  const score = component.score === null ? "not scored" : `${formatScore(component.score)} of 100`;
  return (
    <ScoreRow
      label={(
        <>
          {component.label}
          {scope ? <span className="text-muted-foreground"> · {scope}</span> : null}
        </>
      )}
      detail={component.postureLabel}
      value={formatScore(component.score)}
      valueClassName={muted ? "text-muted-foreground" : TONE_TEXT_CLASS[component.tone]}
      marker={<ControlRoleGlyph role={component.role} />}
      bar={(
        <Bar
          score={component.score}
          label={`${name} (${component.postureLabel}): ${score}. ${CONTROL_COMPONENT_ROLE_LABELS[component.role]}`}
          fillClassName={muted ? DIAGNOSTIC_FILL_CLASS : TONE_FILL_CLASS[component.tone]}
          outlined={component.role === "limiting"}
          dashed={muted}
        />
      )}
    />
  );
}

function ControlGroupRow({ group }: { group: ControlStripComponentGroup }) {
  const muted = group.role === "diagnostic" || group.role === "excluded";
  const range = group.minScore === null
    ? "–"
    : group.maxScore !== null && group.maxScore !== group.minScore
      ? `${formatScore(group.minScore)}–${formatScore(group.maxScore)}`
      : formatScore(group.minScore);
  const name = `${group.count} ${group.noun}`;
  return (
    <ScoreRow
      label={name}
      detail={group.postureLabel}
      value={range}
      valueClassName={muted ? "text-muted-foreground" : TONE_TEXT_CLASS[group.tone]}
      marker={<ControlRoleGlyph role={group.role} />}
      bar={(
        <Bar
          score={group.minScore}
          range={group.maxScore}
          label={`${name}${group.postureLabel ? ` (${group.postureLabel})` : ""} scored ${range}. ${CONTROL_COMPONENT_ROLE_LABELS[group.role]}`}
          fillClassName={muted ? DIAGNOSTIC_FILL_CLASS : TONE_FILL_CLASS[group.tone]}
          outlined={group.role === "limiting"}
          dashed={muted}
        />
      )}
    />
  );
}

function UnresolvedBridgesRow({ delta }: { delta: number }) {
  const priced = `Priced as the ${formatDelta(delta)} adjustment, not as bridge components`;
  return (
    <ScoreRow
      label="Bridged deployments"
      detail="Unresolved"
      value="–"
      valueClassName="text-muted-foreground"
      bar={<Bar score={null} label={`Bridged deployments: unresolved, not scored as components. ${priced}.`} fillClassName={DIAGNOSTIC_FILL_CLASS} />}
      caption={priced}
    />
  );
}

/** Roles drawn on at least one row, in legend order. */
function markedRoles(view: ControlStripView): Array<"limiting" | "diagnostic"> {
  const roles = new Set(view.rows.flatMap((row) =>
    row.type === "component" ? [row.component.role] : row.type === "group" ? [row.group.role] : []));
  return (["limiting", "diagnostic"] as const).filter((role) => roles.has(role));
}

const ROLE_LEGEND_TEXT = {
  limiting: "lowest eligible input",
  diagnostic: "not in the eligible set",
} as const;

function ControlBody({ view, posture }: { view: ControlStripView; posture: ControlPostureView | null }) {
  const baseline = view.minimum ?? view.evaluatedScore;
  const legend = markedRoles(view);
  const showAdjustment = view.adjusted && baseline !== null;
  const noEligible = view.minimum === null && view.rows.length > 0;
  return (
    <>
      {view.rows.length > 0 ? (
        <ul aria-label="Control components" className={LIST_GRID_CLASS}>
          {view.rows.map((row) => row.type === "component"
            ? <ControlComponentRow key={row.component.key} component={row.component} scope={row.scope} />
            : row.type === "group"
              ? <ControlGroupRow key={row.group.key} group={row.group} />
              : <UnresolvedBridgesRow key="unresolved-bridges" delta={row.delta} />)}
        </ul>
      ) : null}
      {legend.length > 0 || noEligible || showAdjustment ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
          {/* A key for the row glyphs; every bar already names its role. */}
          {legend.map((role) => (
            <span key={role} aria-hidden="true" className="inline-flex items-center gap-1.5">
              <ControlRoleTag role={role} size="compact" />
              {ROLE_LEGEND_TEXT[role]}
            </span>
          ))}
          {noEligible ? (
            <span>
              {/* The schema publishes a null evaluated score for an excluded pillar
                  (excluded-a-b); only a non-null one is the neutral fallback. */}
              {view.evaluatedScore === null
                ? "No eligible control component · Control not scored"
                : <>No eligible control component · neutral score <span className={FIGURE_CLASS}>{formatScore(view.evaluatedScore)}</span></>}
            </span>
          ) : null}
          {showAdjustment ? (
            <span className="@2xl/strip:ml-auto">
              {view.minimum === null ? "neutral" : "min"} <span className={FIGURE_CLASS}>{formatScore(baseline)}</span>
              {" → adjusted "}
              <span className={cn(FIGURE_CLASS, "font-medium text-foreground")}>{formatScore(view.score)}</span>
              {view.adjustments.map((adjustment) => (
                <span key={adjustment.kind}>
                  {" · "}
                  {adjustment.label} <span className={FIGURE_CLASS}>{formatDelta(adjustment.delta)}</span>
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      {posture ? <ControlPostureRow posture={posture} /> : null}
    </>
  );
}

const PILLAR_LABELS = { backing: "Backing", exit: "Exit", control: "Economic Control" } as const;

export function PillarEvidenceStrip(props: PillarEvidenceStripProps) {
  const { headingId, title } = props;
  const review = props.pillar === "backing" ? (props.mechanismReview ?? null) : null;
  const posture = props.pillar === "control" ? (props.controlPosture ?? null) : null;
  // One provenance anchor per board, on the container: ids stay unique and a
  // jump lands at the strip's top.
  const anchorId = review ? "mechanism-review" : posture ? "control-posture" : undefined;
  if (props.view === null) {
    // Frozen coins and coins without a card keep the bare kicker; the
    // provenance rows still render so their anchors survive.
    const kicker = (
      <h2
        id={headingId}
        className={cn(KICKER_CLASS, "flex items-center gap-3 pt-2 after:h-px after:flex-1 after:bg-border/50")}
      >
        {title}
      </h2>
    );
    if (!review && !posture) return kicker;
    return (
      <div id={anchorId} className={cn("space-y-3", SECTION_SCROLL_MT)} data-pillar-strip={props.pillar}>
        {kicker}
        {review ? <MechanismReviewRow review={review} /> : null}
        {posture ? <ControlPostureRow posture={posture} /> : null}
      </div>
    );
  }
  return (
    <div
      id={anchorId}
      className={cn("@container/strip space-y-3", anchorId && SECTION_SCROLL_MT)}
      data-pillar-strip={props.pillar}
    >
      <StripHeader headingId={headingId} title={title} view={props.view} pillarLabel={PILLAR_LABELS[props.pillar]} />
      {props.pillar === "backing" ? <BackingBody view={props.view} review={review} /> : null}
      {props.pillar === "exit" ? <ExitBody view={props.view} /> : null}
      {props.pillar === "control" ? <ControlBody view={props.view} posture={posture} /> : null}
    </div>
  );
}
