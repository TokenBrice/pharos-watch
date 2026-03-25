"use client";

import Link from "next/link";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins";
import { formatCurrency } from "@shared/lib/format";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface DependencyMapHubSummary {
  id: string;
  dependentCount: number;
  weightedInbound: number;
  mcap: number;
  examples: string[];
}

interface DependencyMapMobileSummaryProps {
  hubs: readonly DependencyMapHubSummary[];
  logos?: Record<string, string>;
}

export function DependencyMapMobileSummary({ hubs, logos }: DependencyMapMobileSummaryProps) {
  if (hubs.length === 0) return null;

  return (
    <Card className="rounded-2xl border-border/70 md:hidden">
      <CardHeader className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="pharos-kicker">Mobile Summary</p>
            <CardTitle as="h2" className="text-lg">
              Top dependency hubs
            </CardTitle>
          </div>
          <span className="text-xs text-muted-foreground">Top {hubs.length}</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Ranked by how many live stablecoins depend on them and how much weighted dependency flows inward.
        </p>
      </CardHeader>
      <CardContent className="divide-y divide-border/40 pt-0">
        {hubs.map((hub, index) => {
          const coin = TRACKED_META_BY_ID.get(hub.id);
          if (!coin) return null;

          return (
            <Link
              key={hub.id}
              href={`/stablecoin/${hub.id}`}
              className="flex items-start gap-3 px-1 py-3 transition-colors hover:bg-muted/30 first:pt-0"
            >
              <span className="mt-0.5 font-mono text-xs text-muted-foreground">
                {String(index + 1).padStart(2, "0")}
              </span>
              <StablecoinLogo src={logos?.[hub.id]} name={coin.name} size={28} />
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{coin.name}</p>
                    <p className="text-xs text-muted-foreground">{coin.symbol}</p>
                  </div>
                  <span className="rounded-full border border-border/50 bg-background/50 px-2.5 py-1 text-xs text-muted-foreground">
                    {hub.dependentCount} dependents
                  </span>
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span className="rounded-full border border-border/50 bg-background/50 px-2.5 py-1">
                    Weighted inbound {hub.weightedInbound.toFixed(2)}
                  </span>
                  <span className="rounded-full border border-border/50 bg-background/50 px-2.5 py-1">
                    Mcap {formatCurrency(hub.mcap, 1)}
                  </span>
                </div>

                {hub.examples.length > 0 && (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Major dependents: {hub.examples.join(", ")}
                  </p>
                )}
              </div>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
