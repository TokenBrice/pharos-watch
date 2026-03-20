"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildAdminApiPath, buildAdminFetchInit, type AdminAccess } from "@/lib/admin-access";
import { buildRequestUrl } from "@/lib/api";
import { DISCOVERY_MIN_MCAP } from "@shared/lib/status-thresholds";
import type { DiscoveryCandidate } from "@shared/types";
import { useState } from "react";
import { formatElapsedSeconds } from "@shared/lib/format";

function formatMcap(mcap: number | null): string {
  if (mcap == null) return "—";
  if (mcap >= 1e9) return `$${(mcap / 1e9).toFixed(1)}B`;
  if (mcap >= 1e6) return `$${(mcap / 1e6).toFixed(1)}M`;
  return `$${mcap.toLocaleString()}`;
}

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

export function DiscoveryCandidatesCard({
  candidates,
  adminAccess,
  nowSeconds,
  onDismissed,
}: {
  candidates: DiscoveryCandidate[] | null;
  adminAccess: AdminAccess;
  nowSeconds: number;
  onDismissed?: () => void;
}) {
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [dismissError, setDismissError] = useState<string | null>(null);

  if (!candidates || candidates.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Coverage Discovery</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No untracked stablecoins above ${formatMcap(DISCOVERY_MIN_MCAP)} found.</p>
        </CardContent>
      </Card>
    );
  }

  const handleDismiss = async (id: number) => {
    setDismissError(null);
    try {
      const res = await fetch(buildRequestUrl(buildAdminApiPath(`/api/discovery-candidates/${id}/dismiss`, adminAccess)), {
        method: "POST",
        ...buildAdminFetchInit(),
      });
      if (res.ok) {
        setDismissed((prev) => new Set([...prev, id]));
        onDismissed?.();
      } else {
        const text = await res.text();
        setDismissError(`${res.status}: ${text}`);
      }
    } catch (err) {
      setDismissError(err instanceof Error ? err.message : "Unknown error");
    }
  };

  const visible = candidates.filter((c) => !dismissed.has(c.id));

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Coverage Discovery</CardTitle>
          <span className="text-xs text-muted-foreground">{visible.length} candidates</span>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {dismissError && (
          <div className="rounded-md border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700 dark:text-red-400">
            Dismiss failed: {dismissError}
          </div>
        )}
        {visible.map((c) => (
          <div key={c.id} className="flex items-center justify-between gap-2 rounded-md border border-border/50 px-3 py-2">
            <div className="flex items-center gap-2 overflow-hidden">
              <span className="shrink-0 font-mono text-sm font-medium">{c.symbol}</span>
              <span className="truncate text-xs text-muted-foreground">{c.name}</span>
              <SourceBadge source={c.source} />
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="font-mono text-xs">{formatMcap(c.marketCap)}</span>
              <span className="text-[10px] text-muted-foreground">{c.daysSeen}d seen</span>
              <span className="text-[10px] text-muted-foreground">
                seen {formatElapsedSeconds(Math.max(0, nowSeconds - c.lastSeen))} ago
              </span>
              <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => handleDismiss(c.id)}>
                Dismiss
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
