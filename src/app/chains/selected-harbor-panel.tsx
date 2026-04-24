import Image from "next/image";
import { Anchor, ShipWheel } from "lucide-react";
import { HEALTH_BADGE_CLASSES, trendColor } from "@/lib/chain-ui";
import { logosById } from "@/lib/logos";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatSignedPercent } from "@shared/lib/format";
import type { ChainHarborEntry } from "./harbor-map";

function HealthPill({ entry }: { entry: ChainHarborEntry }) {
  if (entry.healthScore == null || entry.healthBand == null) {
    return <span className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">NR</span>;
  }
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium capitalize", HEALTH_BADGE_CLASSES[entry.healthBand])}>
      {entry.healthScore} {entry.healthBand}
    </span>
  );
}

export function SelectedHarborPanel({ entry }: { entry: ChainHarborEntry | null }) {
  if (!entry) return null;
  const topCargos = entry.cargos.slice(0, 3);

  return (
    <section className="rounded-xl border border-border/70 bg-card p-4" aria-labelledby="selected-harbor-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Image
            src={entry.logoPath}
            alt=""
            width={36}
            height={36}
            className={cn("rounded-full", entry.darkInvert ? "dark:invert" : "")}
            style={{ width: 36, height: 36 }}
          />
          <div className="min-w-0">
            <p className="pharos-kicker">Selected Harbor</p>
            <h2 id="selected-harbor-heading" className="truncate text-lg font-semibold tracking-tight">
              {entry.name}
            </h2>
          </div>
        </div>
        <HealthPill entry={entry} />
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <Anchor className="h-3.5 w-3.5" aria-hidden />
            Supply docked
          </p>
          <p className="mt-1 font-mono text-lg font-bold tabular-nums">{formatCompactUsd(entry.totalUsd)}</p>
          <p className="text-xs text-muted-foreground">{entry.sharePct.toFixed(2)}% of tracked supply</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Stablecoins</p>
          <p className="mt-1 font-mono text-lg font-bold tabular-nums">{entry.stablecoinCount}</p>
          <p className="text-xs text-muted-foreground">chain-local tracked assets</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Dominant cargo</p>
          <p className="mt-1 font-mono text-lg font-bold tabular-nums">{entry.dominantSymbol}</p>
          <p className="text-xs text-muted-foreground">
            {entry.dominantSharePct.toFixed(1)}% / {formatCompactUsd(entry.dominantCargoUsd)}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
          <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <ShipWheel className="h-3.5 w-3.5" aria-hidden />
            7d wake
          </p>
          <p className={cn("mt-1 font-mono text-lg font-bold tabular-nums", trendColor(entry.change7dPct))}>
            {formatSignedPercent(entry.change7dPct * 100, 2)}
          </p>
          <p className="text-xs text-muted-foreground">supply change</p>
        </div>
      </div>

      <div className="mt-4">
        <p className="pharos-kicker">Top cargo marks</p>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          {topCargos.map((cargo) => {
            const logoPath = logosById[cargo.id];
            return (
              <div key={`${entry.id}-${cargo.id}`} className="rounded-lg border border-border/60 bg-background/40 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/70 bg-background shadow-sm">
                      {logoPath ? (
                        <Image
                          src={logoPath}
                          alt=""
                          width={28}
                          height={28}
                          className="h-full w-full object-contain"
                          style={{ width: 28, height: 28 }}
                        />
                      ) : (
                        <span className="font-mono text-xs font-semibold text-muted-foreground">
                          {cargo.symbol.charAt(0)}
                        </span>
                      )}
                    </span>
                    <span className="truncate font-medium">{cargo.symbol}</span>
                  </span>
                  <span className="shrink-0 font-mono text-sm font-semibold tabular-nums">
                    {cargo.sharePct.toFixed(1)}%
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{formatCompactUsd(cargo.cargoUsd)} on {entry.name}</p>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        The selected harbor reads the same supply, health, wake, and cargo fields encoded in the chart. It is not issuer redemption capacity.
      </p>
    </section>
  );
}
