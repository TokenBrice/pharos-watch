"use client";

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { DEWSBadge } from "@/components/dews-badge";
import { PSI_ELIGIBLE_META_BY_ID } from "@/lib/psi-eligible";
import type { ThreatBand } from "@/lib/classification";

export function DEWSSummary() {
  const { data, isLoading } = useStressSignals();

  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <CardTitle as="h2">Depeg Early Warning</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-20 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.signals || Object.keys(data.signals).length === 0) {
    return null; // No data yet — hide widget entirely
  }

  // Sort by score descending, filter to non-CALM
  const entries = Object.entries(data.signals)
    .map(([id, entry]) => ({ id, ...entry }))
    .filter((e) => e.band !== "CALM")
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const totalCoins = Object.keys(data.signals).length;
  const calmCount = totalCoins - Object.values(data.signals).filter((e) => e.band !== "CALM").length;

  return (
    <Card>
      <CardHeader>
        <CardTitle as="h2">Depeg Early Warning</CardTitle>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All {totalCoins} tracked coins at Calm. No stress signals detected.
          </p>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => {
              const meta = PSI_ELIGIBLE_META_BY_ID.get(entry.id);
              const symbol = meta?.symbol ?? entry.id;
              return (
                <Link
                  key={entry.id}
                  href={`/stablecoin/${entry.id}`}
                  className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-muted/50 transition-colors"
                >
                  <span className="text-sm font-medium truncate">{symbol}</span>
                  <div className="flex items-center gap-2">
                    <DEWSBadge
                      score={entry.score}
                      band={entry.band as ThreatBand}
                      signals={entry.signals}
                    />
                    <span className="text-xs font-mono tabular-nums text-muted-foreground w-8 text-right">
                      {entry.score}
                    </span>
                  </div>
                </Link>
              );
            })}
            {calmCount > 0 && (
              <p className="text-xs text-muted-foreground pt-1">
                {calmCount} coin{calmCount !== 1 ? "s" : ""} at Calm
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
