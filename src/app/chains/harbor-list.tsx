"use client";

import Image from "next/image";
import { Anchor, Activity, ShipWheel } from "lucide-react";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import type { ChainSummary } from "@shared/types/chains";
import { HEALTH_BADGE_CLASSES, HEALTH_FILL_CLASSES, HEALTH_TEXT_CLASSES, trendColor } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import { buildChainHarborModel } from "./harbor-map";

function formatPercentValue(value: number): string {
  return `${value.toFixed(value >= 10 ? 1 : 2)}%`;
}

function ChainHarborMetric({
  icon,
  label,
  value,
  detail,
  mono = true,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  detail: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-background/35 p-3">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className={cn("mt-1 min-w-0 break-words text-lg font-bold tabular-nums", mono ? "font-mono" : "font-sans")}>{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function HarborList({
  chains,
  globalTotalUsd,
}: {
  chains: ChainSummary[];
  globalTotalUsd: number;
}) {
  const model = buildChainHarborModel(chains, globalTotalUsd);
  if (model.entries.length === 0) return null;

  return (
    <section className="pharos-card-shell overflow-hidden" aria-labelledby="chain-harbor-heading">
      <div className="pharos-panel-header flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Harbor Map</p>
          <h2 id="chain-harbor-heading" className="text-lg font-semibold tracking-tight">
            Where stablecoin supply is docked
          </h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Chain size is cargo; health and dominant-coin share show whether each port is resilient or concentrated.
          </p>
        </div>
        <div className="rounded-full border border-frost-blue/30 bg-frost-blue/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
          Top {model.entries.length} chains hold {formatPercentValue(model.topSharePct)}
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(18rem,0.75fr)]">
        <div className="space-y-3">
          {model.entries.map((entry, index) => {
            const healthClass = entry.healthBand ? HEALTH_TEXT_CLASSES[entry.healthBand] : "text-muted-foreground";
            const fillClass = entry.healthBand ? HEALTH_FILL_CLASSES[entry.healthBand] : "bg-muted-foreground";
            return (
              <div
                key={entry.id}
                className="grid grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border/60 bg-background/35 px-3 py-2.5 sm:grid-cols-[2rem_minmax(8rem,0.95fr)_minmax(0,1.6fr)]"
              >
                <span className="font-mono text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <div className="flex min-w-0 items-center gap-2">
                  <Image
                    src={entry.logoPath}
                    alt=""
                    width={22}
                    height={22}
                    className={cn("rounded-full", entry.darkInvert ? "dark:invert" : "")}
                    style={{ width: 22, height: 22 }}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{entry.name}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">
                      {formatCompactUsd(entry.totalUsd)} / {formatPercentValue(entry.sharePct)}
                    </p>
                  </div>
                </div>
                <div className="col-span-2 min-w-0 space-y-1.5 sm:col-span-1">
                  <div className="h-2.5 overflow-hidden rounded-full bg-muted/45" aria-hidden="true">
                    <div className={cn("h-full rounded-full", fillClass)} style={{ width: `${Math.max(entry.berthPct, 2)}%` }} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <span className={cn("font-mono font-semibold tabular-nums", healthClass)}>
                      {entry.healthScore ?? "NR"} {entry.healthBand ?? "unrated"}
                    </span>
                    <span>
                      Dominant: <span className="font-mono text-foreground">{entry.dominantSymbol}</span>{" "}
                      {formatPercentValue(entry.dominantSharePct)}
                    </span>
                    <span className={cn("font-mono tabular-nums", trendColor(entry.change7dPct))}>
                      {formatSignedPercent(entry.change7dPct * 100, 2)} 7d
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
          <ChainHarborMetric
            icon={<Anchor className="h-4 w-4 text-sky-700 dark:text-sky-300" aria-hidden />}
            label="Largest port"
            value={model.largestHarbor?.name ?? "n/a"}
            detail={`${model.largestHarbor?.dominantSymbol ?? "n/a"} is the dominant cargo there`}
            mono={false}
          />
          <ChainHarborMetric
            icon={<ShipWheel className="h-4 w-4 text-emerald-700 dark:text-emerald-300" aria-hidden />}
            label="Avg health"
            value={model.averageHealthScore ?? "NR"}
            detail={`${model.harborCount} active chain profiles`}
          />
          <ChainHarborMetric
            icon={<Activity className="h-4 w-4 text-amber-700 dark:text-amber-300" aria-hidden />}
            label="Fragile ports"
            value={model.fragileHarbors}
            detail="Chains currently banded fragile or concentrated"
          />
          <div className="rounded-xl border border-border/60 bg-background/35 p-3">
            <p className="pharos-kicker">Health bands</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(["robust", "healthy", "mixed", "fragile", "concentrated"] as const).map((band) => (
                <span key={band} className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", HEALTH_BADGE_CLASSES[band])}>
                  {band}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
      <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">
        Source: Chain health snapshot. Harbor size is supply distribution, not issuer redemption capacity.
      </p>
    </section>
  );
}
