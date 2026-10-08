import type { FailureScenario } from "@shared/types/failure-scenarios";
import { cn } from "@/lib/utils";
import { KeysPill, StepNumber } from "./scenario-glyphs";
import {
  describeScenarioClock,
  formatStepNumbers,
  type ScenarioClockModel,
} from "./scenario-model";

/** One swimlane's height; the label column and the plot share it. */
const ROW_CLASS = "h-7";

/**
 * The scenario on a to-scale clock, T+0 at left to the last instant at right,
 * as swimlanes: the shared trunk, then one row per alternative route, so a
 * route that takes longer places on its own row. Steps sharing an instant in
 * a row fold into one flag whose left edge sits on that instant (flags at the
 * horizon grow leftward instead); a dashed guide drops from each instant to
 * the axis. A step that takes time is a line with its number at the
 * midpoint. The window is a bracket under the axis, labelled from the record,
 * so it never paints over the steps. The path's outcome is the one filled
 * flag. Ordered steps live in the route map; this ruler is where proportion
 * lives.
 */
export function ScenarioClock({
  scenario,
  clock,
  sharedLabel,
}: {
  scenario: FailureScenario;
  clock: ScenarioClockModel;
  sharedLabel: string;
}) {
  const toPercent = (hours: number) => (hours / clock.horizonHours) * 100;
  const hasLanes = clock.rows.some((row) => row.label !== null);
  const instants = [...new Set(clock.rows.flatMap((row) => row.flags.map((flag) => flag.at)))];

  return (
    <figure className="min-w-0 space-y-2.5">
      <div role="img" aria-label={describeScenarioClock(clock, scenario, sharedLabel)} className="min-w-0">
        <div className={cn("grid gap-x-3", hasLanes ? "grid-cols-[4rem_minmax(0,1fr)] sm:grid-cols-[5rem_minmax(0,1fr)]" : "grid-cols-1")}>
          {hasLanes ? (
            <div aria-hidden="true">
              {clock.rows.map((row) => (
                <div key={row.id} className={cn(ROW_CLASS, "flex items-center")}>
                  {row.keys ? (
                    <KeysPill>{row.keys}</KeysPill>
                  ) : (
                    <span className="text-[11px] leading-tight text-muted-foreground">{sharedLabel}</span>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          <div aria-hidden="true" className="relative min-w-0">
            {/* Guides: one dashed drop per instant, from the rows to the axis. */}
            {instants.map((at) => (
              <span
                key={at}
                className="absolute top-0 bottom-0 w-0 border-l border-dashed border-border"
                style={{ left: `${toPercent(at)}%` }}
              />
            ))}
            {clock.rows.map((row) => (
              <div key={row.id} className={cn(ROW_CLASS, "relative")}>
                <span className="absolute inset-x-0 top-1/2 h-px bg-border/50" />
                {row.spans.map((span) => (
                  <span key={span.number}>
                    <span
                      className={cn(
                        "absolute top-1/2 h-0 -translate-y-1/2 border-t-2",
                        span.hypothetical ? "border-dashed border-muted-foreground/60" : "border-foreground/35",
                      )}
                      style={{ left: `${toPercent(span.start)}%`, width: `${toPercent(span.end - span.start)}%` }}
                    />
                    <StepNumber
                      number={span.number}
                      hypothetical={span.hypothetical}
                      terminal={span.terminal}
                      className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
                      style={{ left: `${toPercent((span.start + span.end) / 2)}%` }}
                    />
                  </span>
                ))}
                {row.flags.map((flag) => {
                  const atEnd = flag.at >= clock.horizonHours;
                  return (
                    <StepNumber
                      key={flag.at}
                      label={formatStepNumbers(flag.numbers)}
                      hypothetical={flag.hypothetical}
                      terminal={flag.terminal}
                      className={cn("absolute top-1/2 -translate-y-1/2", atEnd && "-translate-x-full")}
                      style={{ left: `${toPercent(flag.at)}%` }}
                    />
                  );
                })}
              </div>
            ))}

            {/* Axis: baseline, a tick per interval, labels under the ticks. */}
            <div className="relative mt-1 h-1.5 border-t border-foreground/40">
              {clock.ticks.map((tick) => (
                <span
                  key={tick.hours}
                  className="absolute top-0 h-1.5 w-px -translate-x-1/2 bg-foreground/40"
                  style={{ left: `${toPercent(tick.hours)}%` }}
                />
              ))}
            </div>
            <div className="relative h-4">
              {clock.ticks.map((tick, index) => {
                const first = index === 0;
                const last = index === clock.ticks.length - 1;
                // On a phone, intermediate labels thin to every other tick and
                // never crowd the horizon label; every tick mark stays drawn.
                const phoneLabel = first || last || (index % 2 === 0 && index < clock.ticks.length - 2);
                return (
                  <span
                    key={tick.hours}
                    className={cn(
                      "pharos-numeric absolute top-0 whitespace-nowrap text-[10.5px] leading-4",
                      first || last ? "text-foreground/80" : "text-muted-foreground",
                      first ? "" : last ? "-translate-x-full" : "-translate-x-1/2",
                      !phoneLabel && "hidden sm:inline",
                    )}
                    style={{ left: `${toPercent(tick.hours)}%` }}
                  >
                    {tick.label}
                  </span>
                );
              })}
            </div>

            {/* The window: a brace under the axis, its label set into the brace. */}
            {clock.window && scenario.window ? (
              <div className="relative mt-1 h-4">
                <span
                  className="absolute top-0 h-2 rounded-b-[3px] border-x border-b border-foreground/35"
                  style={{
                    left: `${toPercent(clock.window.start)}%`,
                    width: `${toPercent(clock.window.end - clock.window.start)}%`,
                  }}
                />
                <span
                  className="absolute top-0 -translate-x-1/2 whitespace-nowrap bg-card px-2 text-xs font-medium leading-4 text-foreground"
                  style={{ left: `${toPercent((clock.window.start + clock.window.end) / 2)}%` }}
                >
                  {scenario.window.label} · {scenario.window.duration}
                </span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {scenario.window && clock.window ? (
        <figcaption
          className={cn(
            "text-[13px] leading-relaxed text-muted-foreground text-pretty",
            hasLanes && "sm:pl-[calc(5rem+0.75rem)]",
          )}
        >
          {scenario.window.note}
        </figcaption>
      ) : null}
    </figure>
  );
}
