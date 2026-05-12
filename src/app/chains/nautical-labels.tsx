import type { ReactNode } from "react";
import { HEALTH_BADGE_CLASSES, HEALTH_BAND_ORDER } from "@/lib/chain-ui";
import { cn } from "@/lib/utils";
import type { ChainHarborEntry } from "./harbor-map";
import type { ShipGeometry } from "./nautical-geometry";

export function CompassPlate({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  detail: string;
}) {
  return (
    <div className="relative rounded-lg border border-border/70 bg-muted/20 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]">
      <div className="flex items-center gap-2 text-muted-foreground">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 break-words font-mono text-lg font-bold tabular-nums">{value}</p>
      <p className="text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}

export function HealthBandLegend() {
  return (
    <div className="rounded-lg border border-border/70 bg-muted/20 p-3 shadow-[inset_0_1px_0_oklch(1_0_0_/0.05)]">
      <p className="pharos-kicker">Health bands</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {HEALTH_BAND_ORDER.map((band) => (
          <span
            key={band}
            className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium capitalize", HEALTH_BADGE_CLASSES[band])}
          >
            {band}
          </span>
        ))}
      </div>
    </div>
  );
}

export function ShipNameLabels({ geometries }: { geometries: Array<{ entry: ChainHarborEntry; geom: ShipGeometry }> }) {
  return (
    <>
      {geometries.map(({ entry, geom }) => (
        <text
          key={`label-${entry.id}`}
          x={geom.deckLeft + geom.hullW / 2}
          y={geom.hullBottom + 22}
          textAnchor="middle"
          fontSize={9}
          fontFamily="ui-monospace, Menlo, monospace"
          fill="currentColor"
          opacity={0.62}
        >
          {entry.name}
        </text>
      ))}
    </>
  );
}
