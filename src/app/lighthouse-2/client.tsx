"use client";

import { useMemo, useState } from "react";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { useChains } from "@/hooks/use-chains";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { Lighthouse2ExpeditionStage } from "./expedition-stage";
import { buildLighthouse2Model, type Lighthouse2ModuleId } from "./nautical-model";

export function Lighthouse2Client() {
  const chainsQuery = useChains();
  const stabilityQuery = useStabilityIndexDetail();
  const stressQuery = useStressSignals();
  const stablecoinsQuery = useStablecoins();
  const [moduleId, setModuleId] = useState<Lighthouse2ModuleId>("chains");
  const [previewModuleId, setPreviewModuleId] = useState<Lighthouse2ModuleId | null>(null);
  const [selectedMarkId, setSelectedMarkId] = useState<string | null>(null);
  const [previewMarkId, setPreviewMarkId] = useState<string | null>(null);

  const activeModuleId = previewModuleId ?? moduleId;
  const activeMarkId = previewMarkId ?? selectedMarkId;
  const model = useMemo(
    () => buildLighthouse2Model({
      chains: chainsQuery.data?.chains ?? [],
      totalUsd: chainsQuery.data?.globalTotalUsd ?? 0,
      stabilityIndex: stabilityQuery.data?.current ?? null,
      stressSignals: stressQuery.data ?? null,
      stablecoins: stablecoinsQuery.data?.peggedAssets,
      activeModuleId,
      selectedMarkId: activeMarkId,
    }),
    [
      activeMarkId,
      activeModuleId,
      chainsQuery.data?.chains,
      chainsQuery.data?.globalTotalUsd,
      stablecoinsQuery.data?.peggedAssets,
      stabilityQuery.data?.current,
      stressQuery.data,
    ],
  );

  const handleSelectModule = (id: Lighthouse2ModuleId) => {
    setModuleId(id);
    setPreviewModuleId(null);
    setPreviewMarkId(null);
  };

  const handlePreviewMark = (id: string, nextModuleId: Lighthouse2ModuleId) => {
    setPreviewMarkId(id);
    setPreviewModuleId(nextModuleId);
  };

  const handleSelectMark = (id: string, nextModuleId: Lighthouse2ModuleId) => {
    setSelectedMarkId(id);
    setModuleId(nextModuleId);
    setPreviewMarkId(null);
    setPreviewModuleId(null);
  };

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
      <div className="min-h-[calc(100svh-1.5rem)] animate-pulse border border-border/50 bg-muted/20" aria-busy="true">
        <span className="sr-only">Loading Pharos expedition chart.</span>
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
      <Lighthouse2ExpeditionStage
        model={model}
        onPreviewModule={setPreviewModuleId}
        onPreviewEnd={() => {
          setPreviewModuleId(null);
          setPreviewMarkId(null);
        }}
        onSelectModule={handleSelectModule}
        onPreviewMark={handlePreviewMark}
        onSelectMark={handleSelectMark}
      />
    </>
  );
}
