"use client";

import Link from "next/link";
import { formatCurrency } from "@shared/lib/format";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildStablecoinUrl } from "@/lib/urls";
import type { DependencyHubsModel } from "@/lib/dependency-hubs-model";

interface DependencyMapMobileSummaryProps {
  model: DependencyHubsModel;
  logos?: Record<string, string>;
}

export function DependencyMapMobileSummary({ model, logos }: DependencyMapMobileSummaryProps) {
  const hubs = model.hubs.slice(0, 6);
  if (hubs.length === 0) return null;

  return (
    <Card className="rounded-xl border-border/70 shadow-none md:hidden">
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
          Ranked by direct dependents, then summed direct dependency weight and modeled dependent market-cap context.
        </p>
      </CardHeader>
      <CardContent className="divide-y divide-border/40 pt-0">
        {hubs.map((hub, index) => (
          <Link
            key={hub.id}
            href={buildStablecoinUrl(hub.id)}
            className="flex items-start gap-3 px-1 py-3 transition-colors hover:bg-muted/30 first:pt-0"
          >
            <span className="mt-0.5 font-mono text-xs text-muted-foreground">
              {String(index + 1).padStart(2, "0")}
            </span>
            <StablecoinLogo src={logos?.[hub.id]} name={hub.label} size={28} />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold text-foreground">{hub.label}</p>
                  <p className="text-xs text-muted-foreground">{hub.symbol}</p>
                </div>
                <span className="rounded-full border border-border/50 bg-background/50 px-2.5 py-1 text-xs text-muted-foreground">
                  {hub.dependentCount} direct dependents
                </span>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded-full border border-border/50 bg-background/50 px-2.5 py-1">
                  Summed direct dependency weight {hub.summedDirectDependencyWeight.toFixed(2)}
                </span>
                <span className="rounded-full border border-border/50 bg-background/50 px-2.5 py-1">
                  Modeled dependent market-cap context {formatCurrency(hub.uniqueDependentMcapUsd, 1)}
                </span>
                <span className="rounded-full border border-border/50 bg-background/50 px-2.5 py-1">
                  Hub own market cap {formatCurrency(hub.hubMcapUsd, 1)}
                </span>
              </div>

              {hub.examples.length > 0 && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  Example direct dependents: {hub.examples.map((example) => example.symbol).join(", ")}
                </p>
              )}
            </div>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}
