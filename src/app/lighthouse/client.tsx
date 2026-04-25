"use client";
import { useChains } from "@/hooks/use-chains";
import { useStablecoins } from "@/hooks/use-stablecoins";
import { useStabilityIndexDetail, useStressSignals } from "@/hooks/api-hooks";
import { QueryErrorNotice } from "@/components/query-error-notice";
import { LighthouseA11yLedger } from "./lighthouse-a11y-ledger";
import { HarborSceneClient } from "./harbor-scene-client";
import { buildSceneData } from "./systems/scene-data";

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
