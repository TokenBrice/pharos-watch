"use client";

import { useMemo } from "react";
import { useReportCards } from "@/hooks/use-report-cards";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { ContagionGraph } from "@/components/contagion-graph";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { sumPegBuckets } from "@/lib/supply";

export function DependencyMapClient() {
  const { data: reportData, isLoading } = useReportCards();
  const { data: stablecoinsData } = useStablecoins();
  const { data: logos } = useLogos();

  const mcapMap = useMemo(() => {
    if (!stablecoinsData?.peggedAssets) return new Map<string, number>();
    return new Map(
      stablecoinsData.peggedAssets.map((a) => [
        a.id,
        a.circulating ? sumPegBuckets(a.circulating) : 0,
      ]),
    );
  }, [stablecoinsData]);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="pt-4 pb-4">
          <Skeleton className="h-[520px] w-full rounded-lg" />
        </CardContent>
      </Card>
    );
  }

  if (!reportData?.cards) return null;

  return (
    <ContagionGraph
      cards={reportData.cards}
      mcapMap={mcapMap}
      logos={logos}
    />
  );
}
