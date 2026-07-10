"use client";

import { useRef, useState } from "react";
import { API_PATHS } from "@shared/lib/api-endpoints";
import { formatCurrency, formatElapsedSeconds } from "@shared/lib/format";
import { DISCOVERY_MIN_MCAP } from "@shared/lib/status-thresholds";
import type { DiscoveryCandidate, StatusSectionError } from "@shared/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusCardEmptyState } from "@/components/status/page-primitives";
import { AdminMutationFeedback, AdminMutationReceipt } from "./admin-mutation-feedback";
import {
  type AdminMutationIntentExecution,
  type AdminMutationIntentRequest,
  useAdminMutationIntents,
} from "./admin-mutation-intent";

function SourceBadge({ source }: { source: string }) {
  const colors: Record<string, string> = {
    both: "border-green-500/40 text-green-600 dark:text-green-400",
    coingecko: "border-blue-500/40 text-blue-600 dark:text-blue-400",
    defillama: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  };
  return (
    <span className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${colors[source] ?? ""}`}>
      {source === "both" ? "Both" : source === "coingecko" ? "CG" : "DL"}
    </span>
  );
}

function dismissLane(candidateId: number): string {
  return `discovery:dismiss:${candidateId}`;
}

function candidateIdentity(candidate: DiscoveryCandidate): string {
  return `${candidate.symbol} (${candidate.name}, candidate ID ${candidate.id})`;
}

export function DiscoveryCandidatesCard({
  candidates,
  error,
  nowSeconds,
  onDismissed,
}: {
  candidates: DiscoveryCandidate[] | null;
  error?: StatusSectionError;
  nowSeconds: number;
  onDismissed?: () => void;
}) {
  const { executions, execute, retrySame, executeNew } = useAdminMutationIntents();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [pendingCandidate, setPendingCandidate] = useState<DiscoveryCandidate | null>(null);
  const [receipt, setReceipt] = useState<{ execution: AdminMutationIntentExecution; message: string } | null>(null);
  const originRef = useRef<HTMLElement | null>(null);

  if (!candidates || candidates.length === 0) {
    return (
      <StatusCardEmptyState title="Coverage Discovery">
        {error
          ? `Discovery candidate loader failed: ${error.message}`
          : `No untracked stablecoins above ${formatCurrency(DISCOVERY_MIN_MCAP, 1)} found.`}
      </StatusCardEmptyState>
    );
  }

  const pendingLane = pendingCandidate ? dismissLane(pendingCandidate.id) : null;
  const pendingExecution = pendingLane ? executions[pendingLane] : undefined;
  const pendingBusy = pendingExecution?.requestInFlight === true;
  const visible = candidates.filter((candidate) => !dismissed.has(candidate.id));

  function requestDismiss(candidate: DiscoveryCandidate, origin: HTMLElement) {
    setReceipt(null);
    originRef.current = origin;
    setPendingCandidate(candidate);
  }

  function closeDialog() {
    const origin = originRef.current;
    setPendingCandidate(null);
    queueMicrotask(() => origin?.focus());
  }

  async function runDismiss(mode: "start" | "retry" | "new") {
    if (!pendingCandidate) return;
    const laneKey = dismissLane(pendingCandidate.id);
    const request: AdminMutationIntentRequest | undefined =
      mode === "start"
        ? {
            laneKey,
            path: API_PATHS.discoveryCandidateDismiss(pendingCandidate.id),
          }
        : executions[laneKey]?.request;
    if (!request) return;

    const result =
      mode === "retry" ? await retrySame(laneKey) : mode === "new" ? await executeNew(request) : await execute(request);
    if (!result.didStart || result.execution.status !== "succeeded") return;

    const candidate = pendingCandidate;
    setDismissed((previous) => new Set([...previous, candidate.id]));
    setReceipt({
      execution: result.execution,
      message: `Dismissed ${candidate.symbol} (${candidate.name}, candidate ID ${candidate.id}) from the active discovery queue.`,
    });
    setPendingCandidate(null);
    onDismissed?.();
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Coverage Discovery</CardTitle>
          <span className="text-xs text-muted-foreground">{visible.length} candidates</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <AdminMutationReceipt execution={receipt?.execution ?? null} message={receipt?.message ?? null} />
        {visible.map((candidate) => (
          <div
            key={candidate.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2"
          >
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="shrink-0 font-mono tabular-nums text-sm font-medium">{candidate.symbol}</span>
              <span className="truncate text-xs text-muted-foreground">{candidate.name}</span>
              <SourceBadge source={candidate.source} />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="pharos-numeric text-xs">
                {candidate.marketCap == null ? "—" : formatCurrency(candidate.marketCap, 1)}
              </span>
              <span className="text-[10px] text-muted-foreground">{candidate.daysSeen}d seen</span>
              <span className="text-[10px] text-muted-foreground">
                seen {formatElapsedSeconds(Math.max(0, nowSeconds - candidate.lastSeen))} ago
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                aria-label={`Dismiss ${candidateIdentity(candidate)}`}
                onClick={(event) => requestDismiss(candidate, event.currentTarget)}
              >
                Dismiss
              </Button>
            </div>
          </div>
        ))}

        <Dialog
          open={pendingCandidate != null}
          onOpenChange={(open) => {
            if (!open && !pendingBusy) closeDialog();
          }}
        >
          <DialogContent
            showCloseButton={!pendingBusy}
            onEscapeKeyDown={(event) => {
              if (pendingBusy) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              if (pendingBusy) event.preventDefault();
            }}
          >
            {pendingCandidate ? (
              <>
                <DialogHeader>
                  <DialogTitle>Dismiss discovery candidate</DialogTitle>
                  <DialogDescription>{candidateIdentity(pendingCandidate)}</DialogDescription>
                </DialogHeader>
                <dl className="grid gap-3 text-sm">
                  <div>
                    <dt className="font-medium text-foreground">Risk</dt>
                    <dd className="text-muted-foreground">Moderate · audited coverage-triage mutation</dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Exact effect</dt>
                    <dd className="text-muted-foreground">
                      Removes this candidate from the active discovery queue and records its current market cap. It does
                      not add or remove a tracked stablecoin.
                    </dd>
                  </div>
                  <div>
                    <dt className="font-medium text-foreground">Recovery</dt>
                    <dd className="text-muted-foreground">
                      This panel has no restore control. Reverse an accidental dismissal through an audited database
                      repair before the next discovery review.
                    </dd>
                  </div>
                </dl>
                <AdminMutationFeedback
                  execution={pendingExecution}
                  onRetrySame={() => void runDismiss("retry")}
                  onStartNew={() => void runDismiss("new")}
                  newIntentLabel="Start new dismiss intent"
                />
                <DialogFooter>
                  <Button type="button" variant="outline" onClick={closeDialog} disabled={pendingBusy}>
                    Cancel
                  </Button>
                  {pendingExecution?.status !== "failed" && pendingExecution?.status !== "unknown" ? (
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={pendingBusy}
                      aria-busy={pendingBusy}
                      onClick={() => void runDismiss("start")}
                    >
                      {pendingBusy
                        ? "Dismissing..."
                        : `Confirm dismiss of ${pendingCandidate.symbol} (candidate ID ${pendingCandidate.id})`}
                    </Button>
                  ) : null}
                </DialogFooter>
              </>
            ) : null}
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
