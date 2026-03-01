"use client";

import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useStressSignals } from "@/hooks/use-stress-signals";
import { DEWSBadge } from "@/components/dews-badge";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { PSI_ELIGIBLE_META_BY_ID } from "@/lib/psi-eligible";
import type { ThreatBand } from "@/lib/classification";

interface DEWSSummaryProps {
  logos?: Record<string, string>;
}

export function DEWSSummary({ logos }: DEWSSummaryProps) {
  const { data, isLoading } = useStressSignals();

  if (isLoading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <CardTitle as="h2">Depeg Early Warning</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="h-24 bg-muted rounded" />
        </CardContent>
      </Card>
    );
  }

  if (!data?.signals || Object.keys(data.signals).length === 0) {
    return null;
  }

  // Sort by score descending, filter to non-CALM
  const elevated = Object.entries(data.signals)
    .map(([id, entry]) => ({ id, ...entry }))
    .filter((e) => e.band !== "CALM")
    .sort((a, b) => b.score - a.score);

  const totalCoins = Object.keys(data.signals).length;
  const calmCount = totalCoins - elevated.length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle as="h2">Depeg Early Warning</CardTitle>
          <span className="text-xs text-muted-foreground">
            {elevated.length > 0
              ? `${elevated.length} elevated · ${calmCount} calm`
              : `All ${totalCoins} coins calm`}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        {elevated.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All {totalCoins} tracked coins at Calm. No stress signals detected.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
            {elevated.map((entry) => {
              const meta = PSI_ELIGIBLE_META_BY_ID.get(entry.id);
              const symbol = meta?.symbol ?? entry.id;
              const name = meta?.name ?? symbol;
              const logoUrl = logos?.[entry.id];
              return (
                <Link
                  key={entry.id}
                  href={`/stablecoin/${entry.id}`}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors"
                >
                  <StablecoinLogo src={logoUrl} name={name} size={20} />
                  <span className="text-sm font-medium truncate flex-1">{symbol}</span>
                  <DEWSBadge
                    score={entry.score}
                    band={entry.band as ThreatBand}
                    signals={entry.signals}
                  />
                  <span className="text-xs font-mono tabular-nums text-muted-foreground w-6 text-right">
                    {entry.score}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
