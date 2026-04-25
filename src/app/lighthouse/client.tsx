"use client";
import dynamic from "next/dynamic";
import { useChains } from "@/hooks/use-chains";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { LighthouseA11yLedger } from "./lighthouse-a11y-ledger";
import { buildSceneData } from "./systems/scene-data";

const HarborSceneClient = dynamic(
  () => import("./harbor-scene-client").then((m) => ({ default: m.HarborSceneClient })),
  { ssr: false, loading: () => <div className="min-h-[70vh] animate-pulse bg-muted/10" aria-busy="true" /> },
);

export function LighthouseClient() {
  const chainsQuery = useChains();
  const stabilityQuery = useStabilityIndexDetail();
  const stressQuery = useStressSignals();
  const stablecoinsQuery = useStablecoins();

  const scene = buildSceneData({
    chains: chainsQuery.data,
    stability: stabilityQuery.data,
    stress: stressQuery.data,
    stablecoins: stablecoinsQuery.data,
  });

  if (chainsQuery.isError && !chainsQuery.data) {
    return <QueryErrorNotice error={chainsQuery.error} onRetry={() => void chainsQuery.refetch()} />;
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
      <HarborSceneClient scene={scene} />
      <LighthouseA11yLedger scene={scene} />
    </>
  );
}
