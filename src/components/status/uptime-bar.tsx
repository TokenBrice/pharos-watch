import { PUBLIC_COMPONENT_STATE_TONE } from "@shared/lib/classification";
import { DAY_STATE_MIN_HELD_SEC, type ComponentDayCell, type ComponentDayState } from "@/lib/status/public-status-timeline";
import { cn } from "@/lib/utils";

const NO_DATA = { label: "No data", bar: "bg-muted" } as const;

function cellTone(state: ComponentDayState) {
  return state === "no-data" ? NO_DATA : PUBLIC_COMPONENT_STATE_TONE[state];
}

/** "27d operational · 2d delayed · 1d no data": counts over the observed cells, no-data kept separate (R1). */
export function summarizeDayCells(cells: readonly ComponentDayCell[]): string {
  const counts = new Map<ComponentDayState, number>();
  for (const cell of cells) counts.set(cell.state, (counts.get(cell.state) ?? 0) + 1);
  const order: ComponentDayState[] = ["operational", "delayed", "degraded", "outage", "no-data"];
  return order
    .filter((state) => counts.has(state))
    .map((state) => `${counts.get(state)}d ${cellTone(state).label.toLowerCase()}`)
    .join(" · ");
}

/** "2026-10-22: Operational (briefly degraded, under 1 h)": blips below the day threshold stay readable. */
function describeDayCell(cell: ComponentDayCell): string {
  const brief = cell.brief ? ` (briefly ${PUBLIC_COMPONENT_STATE_TONE[cell.brief].label.toLowerCase()}, under ${DAY_STATE_MIN_HELD_SEC / 3600} h)` : "";
  return `${cell.date}: ${cellTone(cell.state).label}${brief}`;
}

/** Daily bar for one public component; each cell is the worst state held for at least 1 h that UTC day (any outage counts). */
export function UptimeBar({ cells, label }: { cells: readonly ComponentDayCell[]; label: string }) {
  return (
    <div className="flex h-5 items-stretch gap-px" role="img" aria-label={`${label}, last ${cells.length} days: ${summarizeDayCells(cells)}`}>
      {cells.map((cell) => (
        <div
          key={cell.date}
          className={cn("min-w-0 flex-1 rounded-xs", cellTone(cell.state).bar)}
          title={describeDayCell(cell)}
        />
      ))}
    </div>
  );
}
