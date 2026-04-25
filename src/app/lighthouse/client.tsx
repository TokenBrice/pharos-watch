"use client";

import { useEffect, useState } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useChains } from "@/hooks/use-chains";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { buildLighthouseCinematicModel, type LighthouseMode, type LighthouseModuleId } from "./cinematic-model";
import { LighthouseFullscreenDialog } from "./lighthouse-fullscreen-dialog";
import { LighthouseStage } from "./lighthouse-stage";

const MODULE_MODE: Record<LighthouseModuleId, LighthouseMode> = {
  harbors: "watch",
  lens: "lens",
  radar: "radar",
  atlas: "atlas",
};

export function LighthouseClient() {
  const chainsQuery = useChains();
  const stabilityQuery = useStabilityIndexDetail();
  const stressQuery = useStressSignals();
  const stablecoinsQuery = useStablecoins();
  const [manualSelectedId, setManualSelectedId] = useState<string | null>(null);
  const [previewSelectedId, setPreviewSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<LighthouseMode>("watch");
  const [previewMode, setPreviewMode] = useState<LighthouseMode | null>(null);
  const [isPinned, setIsPinned] = useState(false);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);

  const effectiveMode = previewMode ?? mode;

  const handleSelect = (id: string) => {
    setIsPinned(true);
    setManualSelectedId(id);
    setPreviewSelectedId(null);
  };

  const handleModeCommit = (nextMode: LighthouseMode) => {
    setMode(nextMode);
    setPreviewMode(null);
  };

  const handlePreviewModule = (id: LighthouseModuleId) => {
    setPreviewMode(MODULE_MODE[id]);
  };

  const handleSelectModule = (id: LighthouseModuleId) => {
    handleModeCommit(MODULE_MODE[id]);
  };

  const model = buildLighthouseCinematicModel({
    chains: chainsQuery.data?.chains ?? [],
    totalUsd: chainsQuery.data?.globalTotalUsd ?? 0,
    stabilityIndex: stabilityQuery.data?.current ?? null,
    stressSignals: stressQuery.data ?? null,
    stablecoins: stablecoinsQuery.data?.peggedAssets,
    selectedHarborId: previewSelectedId ?? manualSelectedId,
    mode: effectiveMode,
  });

  useEffect(() => {
    if (isPinned || previewSelectedId || effectiveMode !== "watch" || model.harbors.visible.length <= 1) return;
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
  }, [effectiveMode, isPinned, model.stage.selectedHarborId, model.harbors.visible, previewSelectedId]);

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
        className="min-h-[calc(100svh-1.5rem)] animate-pulse border border-border/50 bg-muted/20"
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
        fullscreenOpen={fullscreenOpen}
        onModeChange={handleModeCommit}
        onExpandStage={() => setFullscreenOpen(true)}
        onPreviewModule={handlePreviewModule}
        onPreviewModuleEnd={() => setPreviewMode(null)}
        onSelectModule={handleSelectModule}
        onSelectHarbor={handleSelect}
        onPreviewHarbor={setPreviewSelectedId}
        onPreviewEnd={() => setPreviewSelectedId(null)}
      />
      <LighthouseFullscreenDialog
        open={fullscreenOpen}
        model={model}
        onOpenChange={setFullscreenOpen}
        onModeChange={handleModeCommit}
        onPreviewModule={handlePreviewModule}
        onPreviewModuleEnd={() => setPreviewMode(null)}
        onSelectModule={handleSelectModule}
        onSelectHarbor={handleSelect}
        onPreviewHarbor={setPreviewSelectedId}
        onPreviewEnd={() => setPreviewSelectedId(null)}
      />
    </>
  );
}
