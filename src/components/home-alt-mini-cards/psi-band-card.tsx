"use client";

import { useMemo } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/api-hooks";
import {
  PSI_BAND_CLASSES,
  PSI_HEX_COLORS,
  type ConditionBand,
} from "@shared/lib/psi-colors";

function PsiSparkline({
  values,
  color,
}: {
  values: number[];
  color: string;
}): React.JSX.Element | null {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = 100 / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = (i * stepX).toFixed(2);
      const y = (40 - ((v - min) / range) * 40).toFixed(2);
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 40"
      className="block h-full w-full"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function PsiBandCard(): React.JSX.Element {
  const { data, isLoading } = useStabilityIndex();
  const current = data?.current ?? null;
  const sparkValues = useMemo(() => {
    const history = data?.history ?? [];
    return history.slice(-90).map((p) => p.score);
  }, [data?.history]);

  const band = (current?.band ?? "STEADY") as ConditionBand;
  const bandColor = PSI_HEX_COLORS[band] ?? PSI_HEX_COLORS.STEADY;
  const bandClass = PSI_BAND_CLASSES[band] ?? "text-foreground";

  return (
    <div className="pharos-card-shell flex items-center gap-4 p-4">
      <div className="min-w-0 shrink-0">
        <p className="pharos-kicker">PSI</p>
        {isLoading || !current ? (
          <Skeleton className="mt-1.5 h-7 w-24" />
        ) : (
          <div className="mt-1 flex items-baseline gap-2">
            <span className="font-mono text-3xl font-semibold tabular-nums text-foreground">
              {current.score.toFixed(1)}
            </span>
            <span
              className={`font-mono text-[10px] font-semibold uppercase tracking-wider ${bandClass}`}
            >
              {band}
            </span>
          </div>
        )}
        <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          Last 90 days
        </p>
      </div>
      <div className="ml-auto h-12 flex-1">
        <PsiSparkline values={sparkValues} color={bandColor} />
      </div>
    </div>
  );
}
