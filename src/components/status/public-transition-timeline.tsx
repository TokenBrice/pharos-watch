"use client";
import type { PublicStatusHistoryWindow, PublicStatusTransition } from "@shared/types";
import { PUBLIC_STATUS_HISTORY_WINDOWS } from "@shared/types/status";
import { DataTableShell, type DataTableColumn } from "@/components/data-table-shell";
import { TableCell, TableRow } from "@/components/table";
import { getStatusTone } from "@/lib/status-dashboard-model";

const TYPE_LABELS: Record<string, string> = {
  degrade: "Degradation",
  recover: "Recovery",
  init: "Initialized",
};

const PUBLIC_TRANSITION_COLUMNS: readonly DataTableColumn[] = [
  { id: "time", label: "Time", className: "pb-2 font-medium" },
  { id: "transition", label: "Transition", className: "pb-2 font-medium" },
  { id: "type", label: "Type", className: "pb-2 font-medium" },
  { id: "reason", label: "Reason", className: "pb-2 font-medium" },
];

interface PublicTransitionTimelineProps {
  transitions: PublicStatusTransition[];
  window: PublicStatusHistoryWindow;
  onWindowChange: (window: PublicStatusHistoryWindow) => void;
  isLoading: boolean;
}

export function PublicTransitionTimeline({
  transitions,
  window,
  onWindowChange,
  isLoading,
}: PublicTransitionTimelineProps) {
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Transition log</p>
          <p className="text-xs text-muted-foreground">
            Window filters this table only. The runway above always summarizes the last 30 days.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {PUBLIC_STATUS_HISTORY_WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onWindowChange(option)}
              aria-pressed={option === window}
              className={`pharos-focus-ring pharos-control-pill px-2.5 py-1 text-xs ${
                option === window ? "pharos-control-pill-active" : ""
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {isLoading && transitions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading status history...</p>
        ) : transitions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No status changes recorded in this window.</p>
        ) : (
          <DataTableShell
            tableId="public-status-transition-timeline"
            testId="public-status-transition-timeline-table"
            columns={PUBLIC_TRANSITION_COLUMNS}
            chrome="content"
            density="compact"
            caption="Public status transition history"
            captionClassName="sr-only"
            headerClassName=""
            headerRowClassName="border-b text-left text-muted-foreground"
          >
            {transitions.map((transition) => {
                const toTone = getStatusTone(transition.to as "healthy" | "degraded" | "stale");
                return (
                  <TableRow key={transition.id} className="border-b last:border-0">
                    <TableCell className="py-2.5 pharos-numeric text-xs text-muted-foreground">
                      {new Date(transition.at * 1000).toLocaleString(undefined, { timeZoneName: "short" })}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <span className="font-mono tabular-nums text-xs">
                        {transition.from ?? "init"} → {transition.to}
                      </span>
                    </TableCell>
                    <TableCell className="py-2.5">
                      <span
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${toTone.badgeClassName}`}
                      >
                        {TYPE_LABELS[transition.transitionType] ?? transition.transitionType}
                      </span>
                    </TableCell>
                    <TableCell className="py-2.5 text-xs leading-relaxed text-muted-foreground">
                      {transition.reason}
                    </TableCell>
                  </TableRow>
                );
              })}
          </DataTableShell>
        )}
      </div>
    </div>
  );
}
