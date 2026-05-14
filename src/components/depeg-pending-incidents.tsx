"use client";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StablecoinLogo } from "@/components/stablecoin-logo";
import { buildStablecoinUrl } from "@/lib/urls";
import type { PendingDepegIncident } from "@/lib/depeg-incident-utils";
import { formatBps, formatElapsedSeconds, formatEventDate } from "@shared/lib/format";

interface DepegPendingIncidentsProps {
  incidents: readonly PendingDepegIncident[];
  logos?: Record<string, string>;
}

function bestDeviation(incident: PendingDepegIncident): number | null {
  return incident.peakSeenBps ?? incident.lastSeenBps ?? incident.firstSeenBps ?? null;
}

export function DepegPendingIncidents({ incidents, logos }: DepegPendingIncidentsProps) {
  if (incidents.length === 0) return null;

  return (
    <Card className="rounded-xl border-amber-500/25">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle as="h2" className="pharos-kicker">
            Pending Incidents
          </CardTitle>
          <Badge
            variant="outline"
            className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          >
            awaiting confirmation
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-y-1.5 lg:grid-cols-3 lg:gap-x-4 lg:gap-y-2">
        {incidents.map((incident) => {
          const deviation = bestDeviation(incident);
          return (
            <Link
              key={`${incident.stablecoinId}:${incident.firstSeenAt}`}
              href={buildStablecoinUrl(incident.stablecoinId)}
              className="pharos-focus-ring flex min-h-14 items-center justify-between gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-amber-500/10"
            >
              <div className="flex min-w-0 items-center gap-3">
                <StablecoinLogo src={logos?.[incident.stablecoinId]} name={incident.symbol} size={20} />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{incident.symbol}</span>
                    <Badge
                      variant="outline"
                      className="border-amber-500/30 bg-amber-500/10 px-1.5 py-0 text-xs text-amber-700 dark:text-amber-300"
                    >
                      {incident.direction}
                    </Badge>
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-600" aria-hidden="true" />
                  </div>
                  <div className="text-xs text-muted-foreground">
                    first seen {formatEventDate(incident.firstSeenAt)}
                    {incident.ageSec != null ? ` · age ${formatElapsedSeconds(incident.ageSec)}` : ""}
                  </div>
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="font-mono text-xs font-semibold text-amber-700 dark:text-amber-300">
                  {deviation != null ? formatBps(deviation) : "pending"}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  awaiting confirmation
                </div>
              </div>
            </Link>
          );
        })}
      </CardContent>
    </Card>
  );
}
