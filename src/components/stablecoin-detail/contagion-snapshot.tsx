"use client";

import { useReportCards } from "@/hooks/api-hooks";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useLogos } from "@/hooks/use-logos";
import { ContagionGraph } from "@/components/contagion-graph";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { DetailSectionTitle } from "./section-title";
import { MethodologyLabel } from "@/components/methodology-hint";
import { getCirculatingRaw } from "@shared/lib/supply";

interface ContagionSnapshotProps {
  stablecoinId: string;
}

export function ContagionSnapshot({ stablecoinId }: ContagionSnapshotProps) {
  const { data: rc } = useReportCards();
  const { data: list } = useStablecoins();
  const { data: logos } = useLogos();
  if (!rc?.cards || !list?.peggedAssets) return null;
  const focus = rc.cards.find((c) => c.id === stablecoinId);
  if (!focus) return null;
  const edges = rc.dependencyGraph?.edges ?? [];
  const touches = edges.filter((e) => e.from === stablecoinId || e.to === stablecoinId);
  if (touches.length === 0) return null;
  const mcapMap = new Map<string, number>();
  for (const coin of list.peggedAssets) {
    mcapMap.set(coin.id, getCirculatingRaw(coin));
  }
  return (
    <Card className="rounded-xl">
      <CardHeader>
        <DetailSectionTitle>
          <MethodologyLabel topic="dependencyRisk">Contagion Snapshot</MethodologyLabel>
        </DetailSectionTitle>
        <p className="text-sm text-muted-foreground">
          Stablecoins one hop away from {focus.symbol} — downstream dependents and upstream dependencies.
        </p>
      </CardHeader>
      <CardContent>
        <ContagionGraph
          cards={rc.cards}
          dependencyEdges={edges}
          mcapMap={mcapMap}
          logos={logos}
          focusCoinId={stablecoinId}
        />
      </CardContent>
    </Card>
  );
}
