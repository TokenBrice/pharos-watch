"use client";

import { useState } from "react";
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

  const activeDate = hoveredDate ?? pinnedDate ?? focusedDate;
  const activeCell = activeDate ? cells.find((cell) => cell.date === activeDate) ?? null : null;

  return (
    <div>
      <div
        className="flex h-5 items-stretch gap-px"
        role="group"
        aria-label={`${label}, last ${cells.length} days: ${summarizeDayCells(cells)}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setPinnedDate(null);
            setFocusedDate(null);
          }
        }}
      >
        {cells.map((cell) => {
          const description = describeDayCell(cell);
          const isSelected = activeDate === cell.date;
          return (
            <button
              key={cell.date}
              type="button"
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
              onFocus={() => setFocusedDate(cell.date)}
              onBlur={() => setFocusedDate((current) => (current === cell.date ? null : current))}
              onClick={() => {
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
      {activeCell ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-2xs text-muted-foreground" aria-live="polite">
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
  );
}
