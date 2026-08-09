import type { ChainRpcConfig } from "../../lib/chain-registry";
import { buildYieldHistoryEvaluationInputsCooperative } from "./coordinator-history";
import { evaluateYieldSourcesCooperative } from "./evaluation";
import { loadYieldHistorySnapshots } from "./history";
import { resolveYieldSources } from "./resolve";
import type { YieldCoordinatorFetchContext } from "./coordinator-fetch-stage";

export interface YieldCoordinatorNormalizeStageParams {
  db: D1Database;
  signal?: AbortSignal;
  chainRpcs?: Map<string, ChainRpcConfig>;
  coingeckoApiKey?: string | null;
  fetched: YieldCoordinatorFetchContext;
}

export async function runYieldCoordinatorNormalizeStage(params: YieldCoordinatorNormalizeStageParams) {
  const { fetched } = params;
  await fetched.reportYieldProgress("source-resolution", "Resolving yield source candidates", "yield", {
    itemsDone: 0,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates"],
      countTotals: {
        yieldBearingCoins: fetched.yieldCoins.length,
        opportunityCoins: fetched.opportunityCoinIdSet.size,
        totalTrackedForYield: fetched.progressTotal,
        dlPools: fetched.dlPools.length,
        supplementalCandidates: fetched.supplementalCandidates.length,
        onChainRatesResolved: fetched.onChainRates.size,
      },
    },
  });
  const { resolved, tier1PrevRates, envelopeRejections } = await resolveYieldSources({
    db: params.db,
    startSec: fetched.startSec,
    sevenDaysAgoSec: fetched.sevenDaysAgoSec,
    dlPools: fetched.dlPools,
    onChainRates: fetched.onChainRates,
    safetyScores: fetched.safetyScores,
    safetySnapshotAvailable: fetched.safetySnapshotAvailable,
    riskFreeRates: fetched.riskFreeRates,
    signal: params.signal,
    chainRpcs: params.chainRpcs,
    coingeckoApiKey: params.coingeckoApiKey,
    supplementalCandidates: fetched.supplementalCandidates,
    stablecoinSupplyById: fetched.stablecoinSupplyById,
  });

  const resolvedWithYield = resolved.filter((entry) => entry.yield != null);
  const resolvedYieldBearingIds = new Set(
    resolvedWithYield.filter((entry) => fetched.yieldCoinIdSet.has(entry.id)).map((entry) => entry.id),
  );
  const resolvedIds = [...new Set(resolvedWithYield.map((entry) => entry.id))];
  await fetched.reportYieldProgress("source-resolution-complete", "Resolved yield source candidates", "yield", {
    itemsDone: resolvedWithYield.length,
    metadata: {
      providerFamilies: ["defillama-yields", "yield-supplemental", "on-chain-rates"],
      countTotals: {
        resolvedSources: resolvedWithYield.length,
        resolvedCoins: resolvedIds.length,
        resolvedYieldBearingCoins: resolvedYieldBearingIds.size,
        envelopeRejections: envelopeRejections.length,
      },
    },
  });

  const resolvedSourceKeysByCoin = new Map<string, Set<string>>();
  for (const entry of resolvedWithYield) {
    const resolvedYield = entry.yield;
    if (!resolvedYield) continue;
    const sourceKeySet = resolvedSourceKeysByCoin.get(entry.id) ?? new Set<string>();
    sourceKeySet.add(resolvedYield.sourceKey);
    resolvedSourceKeysByCoin.set(entry.id, sourceKeySet);
  }

  const historySnapshots =
    resolvedIds.length > 0
      ? await loadYieldHistorySnapshots(params.db, resolvedIds, fetched.startSec, fetched.sevenDaysAgoSec, {
          signal: params.signal,
          sourceKeysByStablecoin: resolvedSourceKeysByCoin,
          onProgress: async (progress) => {
            await fetched.reportYieldProgress(
              "history-loading",
              "Loading yield history snapshots",
              "yield-history",
              {
                itemsDone: progress.resolvedIdsDone,
                itemsTotal: progress.resolvedIdsTotal,
                metadata: {
                  countTotals: {
                    resolvedSources: resolvedWithYield.length,
                    resolvedCoins: resolvedIds.length,
                    historyRows: progress.historyRows,
                    previousTvlRows: progress.prevTvlRows,
                    previousBestRows: progress.prevBestRows,
                    previousTvlRowsTruncated: progress.previousTvlRowsTruncated,
                  },
                  chunksDone: progress.chunksDone,
                  chunksTotal: progress.chunksTotal,
                },
              },
            );
          },
        })
      : { historyRows: [], prevTvlRows: [], prevBestRows: [], previousTvlRowsTruncated: false };
  await fetched.reportYieldProgress("history-loaded", "Loaded yield history snapshots", "yield-history", {
    itemsDone: resolvedIds.length,
    itemsTotal: resolvedIds.length,
    metadata: {
      countTotals: {
        historyRows: historySnapshots.historyRows.length,
        previousTvlRows: historySnapshots.prevTvlRows.length,
        previousBestRows: historySnapshots.prevBestRows.length,
        previousTvlRowsTruncated: historySnapshots.previousTvlRowsTruncated,
      },
    },
  });
  const historyInputs = await buildYieldHistoryEvaluationInputsCooperative(historySnapshots, {
    signal: params.signal,
    onProgress: async (progress) => {
      await fetched.reportYieldProgress(
        "history-input-construction",
        "Preparing yield history evaluation inputs",
        "yield-history",
        {
          itemsDone: progress.rowsDone,
          itemsTotal: progress.rowsTotal,
          metadata: {
            phase: progress.phase,
            countTotals: {
              historyRows: historySnapshots.historyRows.length,
              previousTvlRows: historySnapshots.prevTvlRows.length,
              previousBestRows: historySnapshots.prevBestRows.length,
              previousTvlRowsTruncated: historySnapshots.previousTvlRowsTruncated,
            },
          },
        },
      );
    },
  });

  await fetched.reportYieldProgress("evaluation", "Evaluating best yield sources and source risk", "yield", {
    itemsDone: 0,
    metadata: { countTotals: { resolvedSources: resolvedWithYield.length, resolvedCoins: resolvedIds.length } },
  });
  const evaluation = await evaluateYieldSourcesCooperative(
    {
      resolved: resolvedWithYield,
      startSec: fetched.startSec,
      sevenDaysAgoSec: fetched.sevenDaysAgoSec,
      safetyScores: fetched.safetyScores,
      safetySnapshotAvailable: fetched.safetySnapshotAvailable,
      safetyScoreIdentity: fetched.safetySnapshot.safetyScoreIdentity,
      riskFreeRates: fetched.riskFreeRates,
      tier1PrevRates,
      ...historyInputs,
      stablecoinSupplyById: fetched.stablecoinSupplyById,
      dlPoolsMeta: fetched.dlPoolsMeta,
    },
    {
      signal: params.signal,
      onProgress: async (progress) => {
        await fetched.reportYieldProgress("evaluation", "Evaluating best yield sources and source risk", "yield", {
          itemsDone: progress.coinsDone,
          itemsTotal: progress.coinsTotal,
          metadata: {
            phase: progress.phase,
            countTotals: {
              evaluatedSources: progress.evaluatedSources,
              bestSourceCoins: progress.bestSourceCoins,
              rowsRejected: progress.rowsRejected,
              divergenceFlags: progress.divergenceFlags,
              sourceSwitches: progress.sourceSwitches,
            },
          },
        });
      },
    },
  );
  await fetched.reportYieldProgress("evaluation-complete", "Completed yield source evaluation", "yield", {
    itemsDone: evaluation.evaluatedSources.length,
    metadata: {
      countTotals: {
        evaluatedSources: evaluation.evaluatedSources.length,
        bestSourceCoins: evaluation.bestSourceKeyByCoin.size,
        rowsRejected: evaluation.rowsRejected,
        divergenceFlags: evaluation.divergenceFlags,
        sourceSwitches: evaluation.sourceSwitches,
      },
    },
  });

  return {
    resolvedWithYield,
    resolvedYieldBearingIds,
    resolvedIds,
    envelopeRejections,
    historySnapshots,
    ...evaluation,
  };
}

export type YieldCoordinatorNormalizeContext = Awaited<ReturnType<typeof runYieldCoordinatorNormalizeStage>>;
