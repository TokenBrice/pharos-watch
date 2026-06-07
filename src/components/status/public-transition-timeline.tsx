"use client";
import type { PublicStatusHistoryWindow, PublicStatusTransition } from "@shared/types";
import { PUBLIC_STATUS_HISTORY_WINDOWS } from "@shared/types/status";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { getStatusTone } from "@/lib/status-dashboard-model";

const TYPE_LABELS: Record<string, string> = {
  degrade: "Degradation",
  recover: "Recovery",
  init: "Initialized",
};

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
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                option === window
                  ? "bg-foreground text-background"
                  : "border border-border/70 text-muted-foreground hover:text-foreground"
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
          <TableFrame
            tableId="public-status-transition-timeline"
            testId="public-status-transition-timeline-table"
            chrome="content"
            density="compact"
          >
            <TableCaption className="sr-only">Public status transition history</TableCaption>
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                <TableHead scope="col" className="pb-2 font-medium">
                  Time
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Transition
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Type
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Reason
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
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
            </TableBody>
          </TableFrame>
        )}
      </div>
    </div>
  );
}
