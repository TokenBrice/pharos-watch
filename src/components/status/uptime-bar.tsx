"use client";

import { useRef, useState } from "react";
import { PUBLIC_COMPONENT_STATE_TONE } from "@shared/lib/classification";
import { DAY_STATE_MIN_HELD_SEC, type ComponentDayCell, type ComponentDayState } from "@/lib/status/public-status-timeline";
import { cn } from "@/lib/utils";

const NO_DATA = { label: "No data", bar: "bg-muted/60 ring-1 ring-inset ring-border/60" } as const;

function cellTone(state: ComponentDayState) {
  return state === "no-data" ? NO_DATA : PUBLIC_COMPONENT_STATE_TONE[state];
}

/** "27d operational · 2d delayed · 1d no data": counts over the observed cells, no-data kept separate (R1). */
export function summarizeDayCells(cells: readonly ComponentDayCell[]): string {
  const counts = new Map<ComponentDayState, number>();
  let briefCount = 0;
  for (const cell of cells) {
    counts.set(cell.state, (counts.get(cell.state) ?? 0) + 1);
    if (cell.brief) briefCount += 1;
  }
  const order: ComponentDayState[] = ["operational", "delayed", "degraded", "outage", "no-data"];
  const parts = order
    .filter((state) => counts.has(state))
    .map((state) => `${counts.get(state)}d ${cellTone(state).label.toLowerCase()}`);
  if (briefCount > 0) {
    parts.push(`${briefCount}d with brief ${briefCount === 1 ? "blip" : "blips"}`);
  }
  return parts.join(" · ");
}

/** "2026-10-22: Operational (briefly degraded, under 1 h)": blips below the day threshold stay readable. */
function describeDayCell(cell: ComponentDayCell): string {
  const brief = cell.brief ? ` (briefly ${PUBLIC_COMPONENT_STATE_TONE[cell.brief].label.toLowerCase()}, under ${DAY_STATE_MIN_HELD_SEC / 3600} h)` : "";
  return `${cell.date}: ${cellTone(cell.state).label}${brief}`;
}

/** Daily bar for one public component; each cell is the worst state held for at least 1 h that UTC day. */
export function UptimeBar({ cells, label }: { cells: readonly ComponentDayCell[]; label: string }) {
  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const [focusedDate, setFocusedDate] = useState<string | null>(null);
  const [pinnedDate, setPinnedDate] = useState<string | null>(null);
  const [rovingIndex, setRovingIndex] = useState<number>(() => Math.max(0, cells.length - 1));
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const clampedRovingIndex = Math.min(Math.max(0, rovingIndex), Math.max(0, cells.length - 1));
  const activeDate = hoveredDate ?? pinnedDate ?? focusedDate;
  const activeCell = activeDate ? cells.find((cell) => cell.date === activeDate) ?? null : null;

  const focusIndex = (nextIndex: number) => {
    if (cells.length === 0) return;
    const bounded = Math.min(Math.max(0, nextIndex), cells.length - 1);
    setRovingIndex(bounded);
    buttonRefs.current[bounded]?.focus();
  };

  return (
    <div>
      <div
        className="flex h-5 items-stretch gap-px"
        role="group"
        aria-label={`${label}, last ${cells.length} days: ${summarizeDayCells(cells)}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setHoveredDate(null);
            setPinnedDate(null);
            setFocusedDate(null);
          } else if (event.key === "ArrowLeft") {
            event.preventDefault();
            focusIndex(clampedRovingIndex - 1);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            focusIndex(clampedRovingIndex + 1);
          } else if (event.key === "Home") {
            event.preventDefault();
            focusIndex(0);
          } else if (event.key === "End") {
            event.preventDefault();
            focusIndex(cells.length - 1);
          }
        }}
      >
        {cells.map((cell, index) => {
          const description = describeDayCell(cell);
          const isSelected = activeDate === cell.date;
          return (
            <button
              key={cell.date}
              ref={(el) => {
                buttonRefs.current[index] = el;
              }}
              type="button"
              tabIndex={index === clampedRovingIndex ? 0 : -1}
              className={cn(
                "pharos-focus-ring relative min-w-0 flex-1 cursor-pointer overflow-hidden rounded-xs transition-opacity hover:opacity-85 focus-visible:z-10",
                cellTone(cell.state).bar,
                isSelected && "ring-1 ring-foreground/60 ring-offset-1 ring-offset-background",
              )}
              title={description}
              aria-label={description}
              aria-pressed={pinnedDate === cell.date}
              onMouseEnter={() => setHoveredDate(cell.date)}
              onMouseLeave={() => setHoveredDate((current) => (current === cell.date ? null : current))}
              onFocus={() => {
                setRovingIndex(index);
                setFocusedDate(cell.date);
              }}
              onBlur={() => setFocusedDate((current) => (current === cell.date ? null : current))}
              onClick={() => {
                setRovingIndex(index);
                setHoveredDate(null);
                if (pinnedDate === cell.date) {
                  setPinnedDate(null);
                  setFocusedDate(null);
                } else {
                  setPinnedDate(cell.date);
                }
              }}
            >
              {cell.brief ? (
                <span
                  aria-hidden="true"
                  className={cn("pointer-events-none absolute inset-x-0 top-0 h-0.5", PUBLIC_COMPONENT_STATE_TONE[cell.brief].bar)}
                />
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 min-h-4 text-2xs text-muted-foreground" data-testid="uptime-bar-readout">
        {activeCell ? (
          <p className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", cellTone(activeCell.state).bar)} />
            <span>
              <span className="pharos-numeric text-foreground/85">{activeCell.date}</span>
              {`: ${cellTone(activeCell.state).label}`}
              {activeCell.brief
                ? ` (briefly ${PUBLIC_COMPONENT_STATE_TONE[activeCell.brief].label.toLowerCase()}, under ${DAY_STATE_MIN_HELD_SEC / 3600} h)`
                : ""}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
