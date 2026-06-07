"use client";

import { Fragment, useState } from "react";
import type { StatusCause, StatusTransition } from "@shared/types";
import { TableBody, TableCaption, TableCell, TableFrame, TableHead, TableHeader, TableRow } from "@/components/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { StatusHistoryWindow } from "@/hooks/use-status-history";
import { SeverityPill } from "./severity-pill";

const HISTORY_WINDOWS: readonly StatusHistoryWindow[] = ["6h", "24h", "7d", "30d"];

function formatCause(cause: StatusCause): string {
  if (cause.metric && cause.value != null && cause.threshold != null) {
    return `${cause.code} · ${cause.metric}=${cause.value} (threshold ${cause.threshold})`;
  }
  return cause.code;
}

interface TransitionTimelineProps {
  transitions: StatusTransition[];
  window: StatusHistoryWindow;
  onWindowChange: (window: StatusHistoryWindow) => void;
  isLoading: boolean;
}

export function TransitionTimeline({ transitions, window, onWindowChange, isLoading }: TransitionTimelineProps) {
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-base">Incident Timeline</CardTitle>
          <div className="flex flex-wrap gap-2">
            {HISTORY_WINDOWS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onWindowChange(option)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  option === window ? "bg-foreground text-background" : "border border-border/70 text-muted-foreground"
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && transitions.length === 0 ? (
          <p className="text-sm text-muted-foreground">Loading status history...</p>
        ) : transitions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No status transitions recorded in this window.</p>
        ) : (
          <TableFrame
            tableId="status-transition-timeline"
            testId="status-transition-timeline-table"
            chrome="content"
            density="compact"
          >
            <TableCaption className="sr-only">Status transition history</TableCaption>
            <TableHeader>
              <TableRow className="border-b text-left text-muted-foreground">
                <TableHead scope="col" className="pb-2 font-medium">
                  Time
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Transition
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Raw
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Reason
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Confidence
                </TableHead>
                <TableHead scope="col" className="pb-2 font-medium">
                  Causes
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transitions.map((transition) => {
                const isExpanded = expanded[transition.id] ?? false;
                return (
                  <Fragment key={transition.id}>
                    <TableRow className="border-b">
                      <TableHead scope="row" className="py-2 text-left text-xs font-normal text-muted-foreground">
                        {new Date(transition.at * 1000).toLocaleString()}
                      </TableHead>
                      <TableCell className="py-2 font-mono tabular-nums text-xs">
                        {transition.from ?? "init"} → {transition.to}
                      </TableCell>
                      <TableCell className="py-2 font-mono tabular-nums text-xs">{transition.rawStatus}</TableCell>
                      <TableCell className="py-2 text-xs text-muted-foreground">{transition.reason}</TableCell>
                      <TableCell className="py-2 pharos-numeric text-xs">
                        {(transition.confidence * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell className="py-2">
                        <button
                          type="button"
                          onClick={() => setExpanded((prev) => ({ ...prev, [transition.id]: !isExpanded }))}
                          className="text-xs text-muted-foreground hover:text-foreground"
                        >
                          {isExpanded ? "Hide" : "Show"} {transition.causes.length}
                        </button>
                      </TableCell>
                    </TableRow>
                    {isExpanded && (
                      <TableRow className="border-b bg-muted/20 last:border-0">
                        <TableCell colSpan={6} className="py-3">
                          <div className="space-y-2">
                            {transition.causes.length === 0 ? (
                              <div className="text-xs text-muted-foreground">No persisted causes.</div>
                            ) : (
                              transition.causes.map((cause) => (
                                <div
                                  key={`${transition.id}-${cause.code}`}
                                  className="rounded-md border border-border/60 px-3 py-2"
                                >
                                  <div className="flex flex-wrap items-center gap-2">
                                    <SeverityPill severity={cause.severity} />
                                    <span className="font-mono tabular-nums text-[11px] text-muted-foreground">
                                      {formatCause(cause)}
                                    </span>
                                  </div>
                                  <div className="mt-1 text-xs text-muted-foreground">{cause.message}</div>
                                </div>
                              ))
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </TableFrame>
        )}
      </CardContent>
    </Card>
  );
}
