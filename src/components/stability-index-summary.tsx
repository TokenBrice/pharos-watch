"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useStabilityIndex } from "@/hooks/use-stability-index";
import { PsiLighthouse } from "@/components/stability-index";
import { PSI_BAND_CLASSES, PSI_HEX_COLORS, PSI_BORDER_CLASSES } from "@/lib/psi-colors";

export function StabilityIndexSummary() {
  const { data, isLoading } = useStabilityIndex();

  const stats = useMemo(() => {
    if (!data?.current) return null;
    const score = data.current.avg24h ?? data.current.score;
    const band = data.current.avg24hBand ?? data.current.band;
    // History is newest-first; count consecutive days matching current band
    let daysInBand = 1; // today counts
    for (const point of data.history) {
      if (point.band === band) daysInBand++;
      else break;
    }
    return { score, band, daysInBand };
  }, [data]);

  const borderClass = stats ? (PSI_BORDER_CLASSES[stats.band] ?? "border-l-zinc-500") : "border-l-zinc-500";
  const textClass = stats ? (PSI_BAND_CLASSES[stats.band] ?? "text-foreground") : "text-foreground";
  const hexColor = stats ? (PSI_HEX_COLORS[stats.band] ?? "#888") : "#888";

  if (isLoading) {
    return (
      <Card className="rounded-xl border-l-[3px] border-l-zinc-500">
        <CardHeader>
          <Skeleton className="h-4 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  return (
    <Card className={`rounded-xl border-l-[3px] ${borderClass}`}>
      <CardHeader className="pb-2">
        <CardTitle as="h2" className="flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <PsiLighthouse band={stats.band} color={hexColor} size={18} />
            Stability Index
          </span>
          <Link
            href="/stability-index"
            className="text-xs font-normal text-muted-foreground hover:text-foreground transition-colors"
          >
            View history &rarr;
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <p className={`text-2xl font-bold font-mono ${textClass}`}>{stats.score.toFixed(1)}</p>
            <p className="text-xs text-muted-foreground">current score</p>
          </div>
          <div>
            <p className={`text-2xl font-bold font-mono uppercase ${textClass}`}>{stats.band}</p>
            <p className="text-xs text-muted-foreground">condition band</p>
          </div>
          <div>
            <p className="text-2xl font-bold font-mono">{stats.daysInBand}</p>
            <p className="text-xs text-muted-foreground">{stats.daysInBand === 1 ? "day" : "days"} in band</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
