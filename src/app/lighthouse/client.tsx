"use client";

import { useEffect, useState } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useChains } from "@/hooks/use-chains";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { buildLighthouseCinematicModel, type LighthouseMode } from "./cinematic-model";
import { LighthouseStage } from "./lighthouse-stage";

export function LighthouseClient() {
  const chainsQuery = useChains();
  const stabilityQuery = useStabilityIndexDetail();
  const stressQuery = useStressSignals();
  const stablecoinsQuery = useStablecoins();
  const [manualSelectedId, setManualSelectedId] = useState<string | null>(null);
  const [previewSelectedId, setPreviewSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<LighthouseMode>("watch");
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);

  const handleSelect = (id: string) => {
    setIsPinned(true);
    setManualSelectedId(id);
    setPreviewSelectedId(null);
  };

  const model = buildLighthouseCinematicModel({
    chains: chainsQuery.data?.chains ?? [],
    totalUsd: chainsQuery.data?.globalTotalUsd ?? 0,
    stabilityIndex: stabilityQuery.data?.current ?? null,
    stressSignals: stressQuery.data ?? null,
    stablecoins: stablecoinsQuery.data?.peggedAssets,
    selectedHarborId: previewSelectedId ?? manualSelectedId,
    mode,
  });

  useEffect(() => {
    if (isPinned || previewSelectedId || mode !== "watch" || model.harbors.visible.length <= 1) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;

    const intervalId = window.setInterval(() => {
      setManualSelectedId((current) => {
        const visibleIds = model.harbors.visible.map((harbor) => harbor.id);
        if (visibleIds.length === 0) return null;
        const activeId = current ?? model.stage.selectedHarborId;
        const currentIndex = activeId ? visibleIds.indexOf(activeId) : -1;
        return visibleIds[(currentIndex + 1) % visibleIds.length] ?? visibleIds[0] ?? null;
      });
    }, 8_000);

    return () => window.clearInterval(intervalId);
  }, [isPinned, mode, model.stage.selectedHarborId, model.harbors.visible, previewSelectedId]);

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
      <div
        className="min-h-[min(47rem,calc(100svh-7rem))] animate-pulse border border-border/50 bg-muted/20"
        aria-busy="true"
      >
        <span className="sr-only">Loading Pharos Lighthouse.</span>
      </div>
    );
  }

  return (
    <>
      <QueryErrorNotice
        error={chainsQuery.error ?? stabilityQuery.error ?? stressQuery.error ?? stablecoinsQuery.error}
        hasData={!!chainsQuery.data?.chains?.length}
        onRetry={() => {
          void chainsQuery.refetch();
          void stabilityQuery.refetch();
          void stressQuery.refetch();
          void stablecoinsQuery.refetch();
        }}
      />
      <LighthouseStage
        model={model}
        ledgerOpen={ledgerOpen}
        onModeChange={setMode}
        onToggleLedger={() => setLedgerOpen((current) => !current)}
        onSelectHarbor={handleSelect}
        onPreviewHarbor={setPreviewSelectedId}
        onPreviewEnd={() => setPreviewSelectedId(null)}
      />
    </>
  );
}
