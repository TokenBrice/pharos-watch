"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { formatCompactUsd, formatPercent, formatSignedPercent } from "@shared/lib/format";
import type { LighthouseShipRow, LighthouseTailFleet } from "./view-model";
import { cn } from "@/lib/utils";

export function LighthouseFleetList({
  ships,
  selectedId,
  tailFleet,
  onSelect,
}: {
  ships: readonly LighthouseShipRow[];
  selectedId: string | null;
  tailFleet: LighthouseTailFleet | null;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <p className="pharos-kicker">Fleet Manifest</p>
          <p className="text-sm text-muted-foreground">
            Each row is the same harbor data drawn beneath the beam. Select a ship to shift the inspection target.
          </p>
        </div>
        {tailFleet ? (
          <div className="rounded-full border border-border/60 bg-muted/20 px-3 py-1.5 font-mono text-xs text-muted-foreground">
            {tailFleet.label} · {formatCompactUsd(tailFleet.remainingUsd)}
          </div>
        ) : null}
      </div>

      <div className="grid gap-3">
        {ships.map((ship) => {
          const active = ship.id === selectedId;
          return (
            <div
              key={ship.id}
              className={cn(
                "grid gap-3 rounded-[1rem] border px-4 py-3 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,0.95fr)_auto] sm:items-center",
                active ? "border-frost-blue/45 bg-frost-blue/10" : "border-border/60 bg-background/35",
              )}
            >
              <button
                type="button"
                onClick={() => onSelect(ship.id)}
                className="pharos-focus-ring flex min-w-0 items-start gap-3 text-left"
              >
                <span
                  className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background/65"
                  aria-hidden="true"
                >
                  <span
                    className="h-3.5 w-3.5 rounded-full"
                    style={{ backgroundColor: active ? "var(--frost-blue)" : "oklch(0.55 0.03 248)" }}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold text-foreground">{ship.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {ship.healthBand ?? "unrated"} harbor · {ship.stablecoinCount} tracked coins
                  </span>
                </span>
              </button>

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span className="rounded-full border border-border/60 bg-background/55 px-2.5 py-1 font-mono">
                  {formatCompactUsd(ship.totalUsd)}
                </span>
                <span className="rounded-full border border-border/60 bg-background/55 px-2.5 py-1 font-mono">
                  {formatPercent(ship.sharePct, 1)}
                </span>
                <span className="rounded-full border border-border/60 bg-background/55 px-2.5 py-1 font-mono">
                  {formatSignedPercent(ship.change7dPct * 100, 1)} 7d
                </span>
              </div>

              <div className="flex items-center justify-between gap-2 sm:justify-end">
                <p className="text-xs text-muted-foreground">
                  {ship.dominantSymbol} · {formatPercent(ship.dominantSharePct, 1)}
                </p>
                <Link
                  href={`/chains/${encodeURIComponent(ship.id)}/`}
                  className="pharos-focus-ring inline-flex items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2.5 py-1 text-xs font-medium text-foreground hover:border-frost-blue/50 hover:text-foreground"
                >
                  Open
                  <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
