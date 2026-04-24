"use client";

import { useEffect, useState } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { useChains } from "@/hooks/use-chains";
import { useStabilityIndexDetail } from "@/hooks/api-hooks";
import { LighthouseScene } from "./lighthouse-scene";
import { LighthouseFleetList } from "./lighthouse-fleet-list";
import { buildLighthouseSceneModel } from "./view-model";

export function LighthouseClient() {
  const chainsQuery = useChains();
  const stabilityQuery = useStabilityIndexDetail();
  const [manualSelectedId, setManualSelectedId] = useState<string | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const handleSelect = (id: string) => {
    setIsPinned(true);
    setManualSelectedId(id);
  };

  const model = buildLighthouseSceneModel({
    chains: chainsQuery.data?.chains ?? [],
    totalUsd: chainsQuery.data?.globalTotalUsd ?? 0,
    stabilityIndex: stabilityQuery.data?.current ?? null,
    selectedId: manualSelectedId,
  });

  useEffect(() => {
    if (isPinned || model.ships.length <= 1) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;

    const intervalId = window.setInterval(() => {
      setManualSelectedId((current) => {
        const visibleIds = model.ships.map((ship) => ship.id);
        if (visibleIds.length === 0) return null;
        const activeId = current ?? model.selectedId;
        const currentIndex = activeId ? visibleIds.indexOf(activeId) : -1;
        return visibleIds[(currentIndex + 1) % visibleIds.length] ?? visibleIds[0] ?? null;
      });
    }, 8_000);

    return () => window.clearInterval(intervalId);
  }, [isPinned, model.selectedId, model.ships]);

  if (chainsQuery.isError && !chainsQuery.data) {
    return (
      <QueryErrorNotice
        error={chainsQuery.error}
        onRetry={() => {
          void chainsQuery.refetch();
        }}
      />
    );
  }

  if (!chainsQuery.data) {
    return (
      <div className="space-y-6">
        <div className="h-[30rem] animate-pulse rounded-[1.25rem] border border-border/60 bg-muted/20" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="h-24 animate-pulse rounded-xl border border-border/60 bg-muted/20" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <QueryErrorNotice
        error={chainsQuery.error ?? stabilityQuery.error}
        hasData={!!chainsQuery.data?.chains?.length}
        onRetry={() => {
          void chainsQuery.refetch();
          void stabilityQuery.refetch();
        }}
      />

      <StaleDataBanner
        queries={[
          {
            preset: "chains",
            dataUpdatedAt: chainsQuery.dataUpdatedAt,
            error: chainsQuery.error,
            hasData: !!chainsQuery.data?.chains?.length,
            meta: chainsQuery.meta,
          },
          {
            preset: "stabilityIndex",
            dataUpdatedAt: stabilityQuery.dataUpdatedAt,
            error: stabilityQuery.error,
            hasData: !!stabilityQuery.data?.current,
            meta: stabilityQuery.meta,
          },
        ]}
      />

      <LighthouseScene model={model} onSelect={handleSelect} />

      <LighthouseFleetList
        ships={model.ships}
        selectedId={model.selectedId}
        tailFleet={model.tailFleet}
        onSelect={handleSelect}
      />
    </div>
  );
}
