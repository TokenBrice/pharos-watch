"use client";

import type { CSSProperties } from "react";
import Image from "next/image";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { HEALTH_HEX_FILL } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatPercent, formatSignedPercent } from "@shared/lib/format";
import type { LighthouseShipRow, LighthouseTailFleet } from "./view-model";

function healthColor(band: LighthouseShipRow["healthBand"]): string {
  if (!band) return "oklch(0.58 0.03 250)";
  return HEALTH_HEX_FILL[band];
}

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
    <section className="lh-signal-reel" aria-labelledby="lighthouse-signal-reel-heading">
      <div className="lh-signal-reel__header">
        <div>
          <p className="pharos-kicker">Signal Reel</p>
          <h3 id="lighthouse-signal-reel-heading" className="text-base font-semibold text-foreground">
            Harbors under the lens
          </h3>
        </div>
        {tailFleet ? (
          <div className="lh-signal-reel__tail">
            {tailFleet.label} / {formatCompactUsd(tailFleet.remainingUsd)}
          </div>
        ) : null}
      </div>

      <div className="lh-signal-reel__track">
        {ships.map((ship) => {
          const active = ship.id === selectedId;
          const signalColor = healthColor(ship.healthBand);
          const shareWidth = `${Math.max(8, Math.min(100, ship.sharePct * 2))}%`;
          return (
            <article
              key={ship.id}
              className={cn("lh-signal-card", active && "lh-signal-card--active")}
              style={{ "--lh-signal-color": signalColor } as CSSProperties}
            >
              <button type="button" onClick={() => onSelect(ship.id)} className="lh-signal-card__button pharos-focus-ring">
                <span className="lh-signal-card__lens" aria-hidden="true">
                  {ship.logoPath ? (
                    <Image src={ship.logoPath} alt="" width={26} height={26} loading="lazy" />
                  ) : (
                    <span />
                  )}
                </span>
                <span className="lh-signal-card__copy">
                  <span className="lh-signal-card__name">{ship.name}</span>
                  <span className="lh-signal-card__meta">
                    {ship.healthBand ?? "unrated"} / {ship.dominantSymbol} {formatPercent(ship.dominantSharePct, 0)}
                  </span>
                </span>
              </button>

              <div className="lh-signal-card__meter" aria-hidden="true">
                <span style={{ width: shareWidth }} />
              </div>

              <div className="lh-signal-card__facts">
                <span>{formatCompactUsd(ship.totalUsd)}</span>
                <span>{formatPercent(ship.sharePct, 1)}</span>
                <span>{formatSignedPercent(ship.change7dPct * 100, 1)} 7d</span>
              </div>

              <Link href={`/chains/${encodeURIComponent(ship.id)}/`} className="lh-signal-card__link pharos-focus-ring">
                Open
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </article>
          );
        })}
      </div>
    </section>
  );
}
