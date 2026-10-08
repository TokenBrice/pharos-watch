import { Fragment, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { KeysPill, MissingDefenseMark, StepNumber } from "./scenario-glyphs";
import { isHypotheticalStage, stepAnchorId, type RouteStep, type ScenarioRoute } from "./scenario-model";

export type OpenStepHandler = (event: MouseEvent<HTMLAnchorElement>, stageId: string) => void;

interface RouteMapProps {
  route: ScenarioRoute;
  anchorPrefix: string;
  onOpenStep: OpenStepHandler;
}

/**
 * Measured compact-title minimum: a 100px node plus a 32px lock connector.
 * Fork brackets add 24px beyond ordinary hops; reserve another 56px for the
 * evidence body's padding, since the named query measures its ancestor's
 * content box, not the map. Longer titles must be shortened by the author:
 * a three-line title budget is not guaranteed by word count alone.
 * Whole static variants cover ten columns; longer paths stay vertical.
 */
const HORIZONTAL_BREAKPOINTS = [
  { maxLength: 5, show: "hidden @[45rem]/evidence:block", hide: "@[45rem]/evidence:hidden" },
  { maxLength: 7, show: "hidden @[61rem]/evidence:block", hide: "@[61rem]/evidence:hidden" },
  { maxLength: 8, show: "hidden @[69rem]/evidence:block", hide: "@[69rem]/evidence:hidden" },
  { maxLength: 9, show: "hidden @[78rem]/evidence:block", hide: "@[78rem]/evidence:hidden" },
  { maxLength: 10, show: "hidden @[86rem]/evidence:block", hide: "@[86rem]/evidence:hidden" },
];

export function routeMapBreakpoint(length: number) {
  return HORIZONTAL_BREAKPOINTS.find(({ maxLength }) => length <= maxLength);
}

/** Hop lines: solid into an established step, dashed into a hypothetical one. */
const LINE_SOLID = "border-foreground/30";
const LINE_DASHED = "border-dashed border-muted-foreground/70";

function lineTone(dashed: boolean) {
  return dashed ? LINE_DASHED : LINE_SOLID;
}

function ArrowHead({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("absolute h-0 w-0 border-y-4 border-l-[5px] border-y-transparent border-l-foreground/35", className)}
    />
  );
}

/**
 * The open lock on a hop. Hovering it shows the missing defense; the same
 * text is the collapsed line of that step in the step list, so nothing here is
 * hover-only.
 */
function HopLock({ defense, className }: { defense: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("absolute z-[1] inline-flex", className)}>
          <MissingDefenseMark />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-left text-pretty">
        <span className="font-semibold">Missing defense:</span> {defense}
      </TooltipContent>
    </Tooltip>
  );
}

function RouteNodeLink({
  step,
  terminal,
  anchorPrefix,
  onOpenStep,
  className,
  children,
}: {
  step: RouteStep;
  terminal: boolean;
  anchorPrefix: string;
  onOpenStep: OpenStepHandler;
  className?: string;
  children?: ReactNode;
}) {
  const hypothetical = isHypotheticalStage(step.stage);
  return (
    <a
      href={`#${stepAnchorId(anchorPrefix, step.stage.id)}`}
      onClick={(event) => onOpenStep(event, step.stage.id)}
      className={cn("pharos-focus-ring group/node", className)}
    >
      {children ?? (
        <>
          <StepNumber number={step.number} hypothetical={hypothetical} terminal={terminal} />
          <span className="min-w-0 text-[12.5px] font-medium leading-snug text-foreground text-pretty group-hover/node:underline group-hover/node:decoration-foreground/30 group-hover/node:underline-offset-2">
            {step.stage.title}
          </span>
        </>
      )}
      {hypothetical ? <span className="sr-only">, hypothetical step</span> : null}
    </a>
  );
}

const HORIZONTAL_NODE_CLASS =
  "flex h-full min-w-0 items-start gap-1.5 rounded-md border bg-card px-2 py-1.5 transition-colors hover:border-foreground/40 hover:bg-muted/30";

function HorizontalNode({
  step,
  terminal,
  anchorPrefix,
  onOpenStep,
}: {
  step: RouteStep;
  terminal: boolean;
  anchorPrefix: string;
  onOpenStep: OpenStepHandler;
}) {
  const hypothetical = isHypotheticalStage(step.stage);
  return (
    <RouteNodeLink
      step={step}
      terminal={terminal}
      anchorPrefix={anchorPrefix}
      onOpenStep={onOpenStep}
      className={cn(
        HORIZONTAL_NODE_CLASS,
        hypothetical ? "border-dashed border-muted-foreground/60" : "border-border",
        terminal && "border-foreground/45",
      )}
    />
  );
}

/** A straight hop between two nodes of one row, with its lock when a defense is missing. */
function HorizontalHop({ defense, dashed, arrow = true }: { defense?: string; dashed: boolean; arrow?: boolean }) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn("absolute left-0 top-1/2 h-0 border-t", arrow ? "right-1" : "right-0", lineTone(dashed))}
      />
      {arrow ? <ArrowHead className="right-0 top-1/2 -translate-y-1/2" /> : null}
      {defense ? <HopLock defense={defense} className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" /> : null}
    </>
  );
}

/**
 * Left to right, from 56rem: the trunk, a bracket that forks into one row per
 * route (labelled with the route and its key threshold), a bracket that
 * rejoins them, and the rest of the trunk. Trunk nodes span every row and sit
 * at its middle; the brackets are drawn per row so they meet each route's
 * node at its own centre, however tall that row grows.
 */
function HorizontalRouteMap({ route, anchorPrefix, onOpenStep }: RouteMapProps) {
  const laneLength = Math.max(0, ...route.lanes.map((lane) => lane.steps.length));
  const hasLanes = route.lanes.length > 0;
  const columns: string[] = [];
  const cells: ReactNode[] = [];
  const allRows = "1 / -1";
  const isTerminal = (step: RouteStep) => step.stage.id === route.terminalStageId;

  const place = (key: string, column: number, row: string, className: string, children: ReactNode, span = 1) => {
    const style: CSSProperties = { gridColumn: `${column} / span ${span}`, gridRow: row };
    cells.push(
      <div key={key} style={style} className={className}>
        {children}
      </div>,
    );
  };

  const placeTrunk = (steps: readonly RouteStep[]) => {
    steps.forEach((step, index) => {
      columns.push("minmax(0,1fr)");
      place(step.stage.id, columns.length, allRows, "min-w-0 self-center", (
        <HorizontalNode step={step} terminal={isTerminal(step)} anchorPrefix={anchorPrefix} onOpenStep={onOpenStep} />
      ));
      const next = steps[index + 1];
      if (!next) return;
      columns.push("2rem");
      place(`${step.stage.id}:hop`, columns.length, allRows, "relative", (
        <HorizontalHop defense={step.stage.missingDefense} dashed={isHypotheticalStage(next.stage)} />
      ));
    });
  };

  placeTrunk(route.pre);

  if (hasLanes) {
    const lastLane = route.lanes.length - 1;
    const forkFrom = route.pre.at(-1);
    // Fork bracket: the trunk's stub (with the last trunk hop's lock), a
    // spine at 0.75rem from the right edge, and one arm into each route.
    columns.push("2.75rem");
    const forkColumn = columns.length;
    place("fork:stub", forkColumn, allRows, "relative", (
      <>
        <span aria-hidden="true" className={cn("absolute left-0 right-3 top-1/2 h-0 border-t", LINE_SOLID)} />
        {forkFrom?.stage.missingDefense ? (
          <HopLock
            defense={forkFrom.stage.missingDefense}
            className="left-[calc((100%-0.75rem)/2)] top-1/2 -translate-x-1/2 -translate-y-1/2"
          />
        ) : null}
      </>
    ));

    const laneStart = forkColumn + 1;
    const laneSpan = laneLength * 2 - 1;
    for (let index = 0; index < laneLength * 2 - 1; index += 1) {
      columns.push(index % 2 === 0 ? "minmax(0,1fr)" : "2rem");
    }
    columns.push("2.75rem");
    const joinColumn = columns.length;

    route.lanes.forEach((lane, laneIndex) => {
      const labelRow = String(laneIndex * 2 + 1);
      const nodeRow = String(laneIndex * 2 + 2);
      const first = lane.steps[0];
      const last = lane.steps.at(-1);
      const upper = laneIndex > 0;
      const lower = laneIndex < lastLane;

      place(`${lane.branch.id}:label`, laneStart, labelRow, cn("flex min-w-0 items-center gap-2 pb-1.5", upper && "pt-3"), (
        <>
          <span className="truncate text-xs font-medium text-foreground">{lane.branch.label}</span>
          <KeysPill>{lane.branch.keys}</KeysPill>
        </>
      ), laneSpan);

      // The spine runs through the label rows between the first and last routes.
      if (upper) {
        place(`${lane.branch.id}:fork-spine`, forkColumn, labelRow, "relative", (
          <span aria-hidden="true" className={cn("absolute inset-y-0 right-3 w-0 border-l", LINE_SOLID)} />
        ));
        place(`${lane.branch.id}:join-spine`, joinColumn, labelRow, "relative", (
          <span aria-hidden="true" className={cn("absolute inset-y-0 right-3 w-0 border-l", LINE_SOLID)} />
        ));
      }
      place(`${lane.branch.id}:fork`, forkColumn, nodeRow, "relative", (
        <>
          {upper ? <span aria-hidden="true" className={cn("absolute top-0 bottom-1/2 right-3 w-0 border-l", LINE_SOLID)} /> : null}
          {lower ? <span aria-hidden="true" className={cn("absolute top-1/2 bottom-0 right-3 w-0 border-l", LINE_SOLID)} /> : null}
          <span
            aria-hidden="true"
            className={cn("absolute right-1 top-1/2 h-0 w-2 border-t", lineTone(first ? isHypotheticalStage(first.stage) : false))}
          />
          <ArrowHead className="right-0 top-1/2 -translate-y-1/2" />
        </>
      ));

      lane.steps.forEach((step, stepIndex) => {
        const column = laneStart + stepIndex * 2;
        place(step.stage.id, column, nodeRow, "min-w-0 py-0.5", (
          <HorizontalNode step={step} terminal={isTerminal(step)} anchorPrefix={anchorPrefix} onOpenStep={onOpenStep} />
        ));
        const next = lane.steps[stepIndex + 1];
        if (next) {
          place(`${step.stage.id}:hop`, column + 1, nodeRow, "relative", (
            <HorizontalHop defense={step.stage.missingDefense} dashed={isHypotheticalStage(next.stage)} />
          ));
        }
      });
      // A shorter route runs a plain line to the rejoin bracket.
      if (lane.steps.length < laneLength) {
        const from = laneStart + lane.steps.length * 2 - 1;
        place(`${lane.branch.id}:run-out`, from, nodeRow, "relative", (
          <HorizontalHop dashed={false} arrow={false} />
        ), joinColumn - from);
      }

      place(`${lane.branch.id}:join`, joinColumn, nodeRow, "relative", (
        <>
          <span aria-hidden="true" className={cn("absolute left-0 right-3 top-1/2 h-0 border-t", LINE_SOLID)} />
          {upper ? <span aria-hidden="true" className={cn("absolute top-0 bottom-1/2 right-3 w-0 border-l", LINE_SOLID)} /> : null}
          {lower ? <span aria-hidden="true" className={cn("absolute top-1/2 bottom-0 right-3 w-0 border-l", LINE_SOLID)} /> : null}
          {last?.stage.missingDefense ? (
            <HopLock
              defense={last.stage.missingDefense}
              className="left-[calc((100%-0.75rem)/2)] top-1/2 -translate-x-1/2 -translate-y-1/2"
            />
          ) : null}
        </>
      ));
    });

    const joinTo = route.post[0];
    place("join:stub", joinColumn, allRows, "relative", (
      <>
        <span
          aria-hidden="true"
          className={cn("absolute right-1 top-1/2 h-0 w-2 border-t", lineTone(joinTo ? isHypotheticalStage(joinTo.stage) : false))}
        />
        <ArrowHead className="right-0 top-1/2 -translate-y-1/2" />
      </>
    ));
    placeTrunk(route.post);
  }

  return (
    <div
      className="grid min-w-0"
      style={{
        gridTemplateColumns: columns.join(" "),
        gridTemplateRows: hasLanes ? `repeat(${route.lanes.length * 2}, auto)` : "auto",
      }}
    >
      {cells}
    </div>
  );
}

const VERTICAL_GRID_CLASS = "grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-2.5";

/**
 * One vertical step: its number on the spine and its title beside it, then
 * the hop leaving it (with its lock when a defense is missing), so the list
 * holds steps only.
 */
function VerticalStep({
  step,
  terminal,
  incoming,
  hop,
  anchorPrefix,
  onOpenStep,
}: {
  step: RouteStep;
  terminal: boolean;
  incoming: boolean;
  hop: { defense?: string; dashed: boolean } | null;
  anchorPrefix: string;
  onOpenStep: OpenStepHandler;
}) {
  const hypothetical = isHypotheticalStage(step.stage);
  return (
    <li className={VERTICAL_GRID_CLASS}>
      <span aria-hidden="true" className="relative flex justify-center">
        {incoming ? <span className={cn("absolute left-1/2 top-0 h-1.5 w-0 border-l", lineTone(hypothetical))} /> : null}
        {hop ? <span className={cn("absolute left-1/2 bottom-0 top-1.5 w-0 border-l", LINE_SOLID)} /> : null}
        <StepNumber number={step.number} hypothetical={hypothetical} terminal={terminal} className="relative mt-1.5" />
      </span>
      <RouteNodeLink
        step={step}
        terminal={terminal}
        anchorPrefix={anchorPrefix}
        onOpenStep={onOpenStep}
        className="flex min-h-8 min-w-0 items-start rounded-sm py-1.5 text-sm font-medium leading-snug text-foreground text-pretty hover:underline hover:decoration-foreground/30 hover:underline-offset-2"
      >
        {step.stage.title}
      </RouteNodeLink>
      {hop ? (
        <span aria-hidden="true" className="relative h-6">
          <span className={cn("absolute inset-y-0 left-1/2 w-0 border-l", lineTone(hop.dashed))} />
          {hop.defense ? (
            <HopLock defense={hop.defense} className="left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" />
          ) : null}
        </span>
      ) : null}
    </li>
  );
}

function VerticalRun({
  steps,
  route,
  leadIn,
  leadOut,
  anchorPrefix,
  onOpenStep,
}: {
  steps: readonly RouteStep[];
  route: ScenarioRoute;
  /** The run continues a line drawn above it. */
  leadIn: boolean;
  /** A hop (with the last step's lock) leaves the run downward. */
  leadOut: boolean;
  anchorPrefix: string;
  onOpenStep: OpenStepHandler;
}) {
  return (
    <ol className="min-w-0">
      {steps.map((step, index) => {
        const next = steps[index + 1];
        return (
          <VerticalStep
            key={step.stage.id}
            step={step}
            terminal={step.stage.id === route.terminalStageId}
            incoming={index > 0 || leadIn}
            hop={
              next || leadOut
                ? { defense: step.stage.missingDefense, dashed: next ? isHypotheticalStage(next.stage) : false }
                : null
            }
            anchorPrefix={anchorPrefix}
            onOpenStep={onOpenStep}
          />
        );
      })}
    </ol>
  );
}

/**
 * Top to bottom, below 56rem: the trunk on a spine, then the routes stacked
 * on a bus that leaves the spine, each route hanging off it by an arm under
 * its label, separated by "or", and merging back before the trunk resumes.
 */
function VerticalRouteMap({ route, anchorPrefix, onOpenStep, sharedLabel }: RouteMapProps & { sharedLabel: string }) {
  const hasLanes = route.lanes.length > 0;
  return (
    <div className="min-w-0">
      <VerticalRun
        steps={route.pre}
        route={route}
        leadIn={false}
        leadOut={hasLanes}
        anchorPrefix={anchorPrefix}
        onOpenStep={onOpenStep}
      />
      {hasLanes ? (
        <>
          <div className={cn(VERTICAL_GRID_CLASS, "relative")}>
            <span aria-hidden="true" className={cn("absolute inset-y-0 left-3 w-0 border-l", LINE_SOLID)} />
            <div className="col-start-2 min-w-0">
              {route.lanes.map((lane, laneIndex) => {
                const first = lane.steps[0];
                const last = lane.steps.at(-1);
                return (
                  <Fragment key={lane.branch.id}>
                    {laneIndex > 0 ? (
                      <p className="py-1 pl-[2.125rem] text-[11px] font-medium text-muted-foreground">or</p>
                    ) : null}
                    <div role="group" aria-label={`${lane.branch.label}, ${lane.branch.keys}`} className="min-w-0">
                      <div className={VERTICAL_GRID_CLASS}>
                        <span aria-hidden="true" className="relative">
                          <span className={cn("absolute -left-[1.375rem] right-1/2 top-1/2 h-0 border-t", LINE_SOLID)} />
                          <span
                            className={cn(
                              "absolute left-1/2 top-1/2 bottom-0 w-0 border-l",
                              lineTone(first ? isHypotheticalStage(first.stage) : false),
                            )}
                          />
                        </span>
                        <p className="flex min-h-7 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 py-0.5">
                          <span className="text-xs font-medium text-foreground">{lane.branch.label}</span>
                          <KeysPill>{lane.branch.keys}</KeysPill>
                        </p>
                      </div>
                      <VerticalRun
                        steps={lane.steps}
                        route={route}
                        leadIn
                        leadOut={false}
                        anchorPrefix={anchorPrefix}
                        onOpenStep={onOpenStep}
                      />
                      <div aria-hidden={last?.stage.missingDefense ? undefined : true} className={VERTICAL_GRID_CLASS}>
                        <span className="relative h-5">
                          <span className={cn("absolute left-1/2 top-0 bottom-1/2 w-0 border-l", LINE_SOLID)} />
                          <span className={cn("absolute -left-[1.375rem] right-1/2 top-1/2 h-0 border-t", LINE_SOLID)} />
                          {last?.stage.missingDefense ? (
                            <HopLock
                              defense={last.stage.missingDefense}
                              className="-left-[0.3125rem] top-1/2 -translate-x-1/2 -translate-y-1/2"
                            />
                          ) : null}
                        </span>
                      </div>
                    </div>
                  </Fragment>
                );
              })}
              <p className="pb-1 pl-[2.125rem] pt-0.5 text-[11px] text-muted-foreground">{sharedLabel} rejoin</p>
            </div>
          </div>
          <VerticalRun
            steps={route.post}
            route={route}
            leadIn
            leadOut={false}
            anchorPrefix={anchorPrefix}
            onOpenStep={onOpenStep}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The at-a-glance attack path: every step title on its route, the fork drawn
 * as parallel routes that rejoin, and an open lock on every hop that lacks a
 * defense. Each node links to its step in the step-by-step list, which it
 * opens. Horizontal when the path fits (see `HORIZONTAL_BREAKPOINTS`),
 * vertical below that container width; the other drawing is `display: none`,
 * so assistive tech meets one copy.
 */
export function RouteMap({ route, anchorPrefix, onOpenStep, sharedLabel }: RouteMapProps & { sharedLabel: string }) {
  const breakpoint = routeMapBreakpoint(route.length);
  return (
    <TooltipProvider delayDuration={120}>
      {breakpoint ? (
        <div data-route-layout="horizontal" className={breakpoint.show}>
          <HorizontalRouteMap route={route} anchorPrefix={anchorPrefix} onOpenStep={onOpenStep} />
        </div>
      ) : null}
      <div data-route-layout="vertical" className={breakpoint?.hide}>
        <VerticalRouteMap route={route} anchorPrefix={anchorPrefix} onOpenStep={onOpenStep} sharedLabel={sharedLabel} />
      </div>
    </TooltipProvider>
  );
}
