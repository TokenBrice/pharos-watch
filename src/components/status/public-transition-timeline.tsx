"use client";

import {
  PUBLIC_STATUS_HISTORY_WINDOWS,
  type PublicStatusHistoryWindow,
  type PublicStatusTransition,
} from "@shared/types";
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
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">Public status transition history</caption>
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th scope="col" className="pb-2 font-medium">Time</th>
                  <th scope="col" className="pb-2 font-medium">Transition</th>
                  <th scope="col" className="pb-2 font-medium">Type</th>
                  <th scope="col" className="pb-2 font-medium">Reason</th>
                </tr>
              </thead>
              <tbody>
                {transitions.map((transition) => {
                  const toTone = getStatusTone(transition.to as "healthy" | "degraded" | "stale");
                  return (
                    <tr key={transition.id} className="border-b last:border-0">
                      <td className="py-2.5 font-mono text-xs text-muted-foreground">
                        {new Date(transition.at * 1000).toLocaleString(undefined, { timeZoneName: 'short' })}
                      </td>
                      <td className="py-2.5">
                        <span className="font-mono text-xs">
                          {transition.from ?? "init"} → {transition.to}
                        </span>
                      </td>
                      <td className="py-2.5">
                        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${toTone.badgeClassName}`}>
                          {TYPE_LABELS[transition.transitionType] ?? transition.transitionType}
                        </span>
                      </td>
                      <td className="py-2.5 text-xs leading-relaxed text-muted-foreground">{transition.reason}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
