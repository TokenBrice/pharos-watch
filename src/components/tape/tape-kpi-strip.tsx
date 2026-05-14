"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/api-hooks";
import { useMintBurnFlows } from "@/hooks/use-mint-burn-flows";
import { useLatestEvents } from "@/hooks/use-events";

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

interface KpiCellProps {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
  isLoading?: boolean;
  href?: string;
}

function KpiCell({ label, value, sublabel, isLoading, href }: KpiCellProps) {
  const body = (
    <div className="flex flex-col gap-1 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      {isLoading ? (
        <Skeleton className="h-6 w-20" />
      ) : (
        <p className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</p>
      )}
      {sublabel ? <p className="text-[11px] text-muted-foreground">{sublabel}</p> : null}
    </div>
  );
  if (href) {
    return (
      <Link href={href} className="pharos-focus-ring block hover:bg-accent/30 transition-colors">
        {body}
      </Link>
    );
  }
  return body;
}

export function TapeKpiStrip() {
  // `now` is captured at mount so the query keys for `since` filters stay
  // stable across re-renders. Polling refresh happens via the hooks below.
  const [now] = useState(() => Date.now());
  const since24h = now - DAY_MS;
  const since7d = now - 7 * DAY_MS;

  // KPI 1: events in last 24h (count). Backend caps at 500; that's our ceiling.
  const events24h = useLatestEvents({ since: since24h, limit: 500 });

  // KPI 2: open depegs — count current `depeg.opened` events without an
  // `endsAt`. We pull the most recent 100 depeg events; this is sufficient for
  // the masthead headline (Pharos rarely has more open depegs than that).
  const depegLatest = useLatestEvents({ classSlug: "depeg", limit: 100 });
  const openDepegCount = useMemo(() => {
    if (!depegLatest.data?.events) return null;
    return depegLatest.data.events.filter(
      (e) => e.type === "depeg.opened" && e.endsAt == null,
    ).length;
  }, [depegLatest.data]);

  // KPI 3: freezes in last 7 days.
  const freezes7d = useLatestEvents({ classSlug: "freeze", since: since7d, limit: 500 });

  const psi = useStabilityIndex();
  const flows = useMintBurnFlows(24);

  const psiCurrent = psi.data?.current ?? null;
  const psiBand = psiCurrent?.band ?? null;
  const psiScore = psiCurrent?.score ?? null;
  const psiScoreDisplay = psiScore != null ? psiScore.toFixed(1) : "—";

  const gauge = flows.data?.gauge ?? null;
  const gaugeBand = gauge?.band ?? null;
  const gaugeScore = gauge?.score;
  const gaugeScoreDisplay = gaugeScore != null ? gaugeScore.toFixed(0) : "—";

  return (
    <Card className="pharos-card-shell overflow-hidden p-0">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/20 px-4 py-2.5">
        <p className="pharos-kicker">Tape Snapshot</p>
        <p className="text-[11px] text-muted-foreground">Refreshes every 15m</p>
      </div>
      <div className="grid grid-cols-2 divide-x divide-y divide-border/30 sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5">
        <KpiCell
          label="Events 24h"
          value={events24h.data?.events.length ?? "—"}
          isLoading={events24h.isLoading}
        />
        <KpiCell
          label="Open depegs"
          value={openDepegCount ?? "—"}
          isLoading={depegLatest.isLoading}
          href="/tape/?type=depeg.*"
        />
        <KpiCell
          label="Freezes 7d"
          value={freezes7d.data?.events.length ?? "—"}
          isLoading={freezes7d.isLoading}
          href="/tape/?type=freeze.*"
        />
        <KpiCell
          label="PSI"
          value={psiScoreDisplay}
          sublabel={psiBand ?? null}
          isLoading={psi.isLoading}
          href="/stability-index/"
        />
        <KpiCell
          label="Bank Run Gauge"
          value={gaugeScoreDisplay}
          sublabel={gaugeBand ?? null}
          isLoading={flows.isLoading}
          href="/flows/"
        />
      </div>
    </Card>
  );
}
