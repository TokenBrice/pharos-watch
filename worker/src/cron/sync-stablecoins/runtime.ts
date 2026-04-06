import { buildSyncMetadata } from "./shared";
import { detectPriceStaleness, fillMissingSupplyHistory } from "./phase-helpers";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import type { PeggedAsset } from "./enrich-prices";
import {
  buildAbortedCronStageResult,
  reportCronStage,
  returnIfCronStageAborted,
  type CronStageContext,
  type CronStageProgress,
} from "../shared/stage-contracts";

const SEVERE_PRICE_STALENESS_RATIO = 0.98;

export interface StablecoinsStalenessSummary {
  compared: number;
  identical: number;
  identicalRatio: number;
}

export async function reportStablecoinsStage(
  reportProgress: CronProgressReporter | undefined,
  stage: string,
  message: string,
  options?: Omit<CronStageProgress, "stage" | "message">,
): Promise<void> {
  await reportCronStage(reportProgress, {
    stage,
    message,
    itemsDone: options?.itemsDone,
    itemsTotal: options?.itemsTotal,
    metadata: options?.metadata,
  });
}

export function abortResult(signal: AbortSignal | undefined, stage: string): CronResult {
  return buildAbortedCronStageResult({
    signal,
    stage,
    serializeMetadata: (metadata) => buildSyncMetadata({ ...metadata }),
  });
}

export function returnIfAborted(signal: AbortSignal | undefined, stage: string): CronResult | null {
  return returnIfCronStageAborted({
    signal,
    stage,
    serializeMetadata: (metadata) => buildSyncMetadata({ ...metadata }),
  });
}

export async function fillStablecoinsSupplyHistoryStage(
  db: D1Database,
  assets: PeggedAsset[],
  signal?: AbortSignal,
): Promise<CronResult | null> {
  try {
    const fillAbort = returnIfAborted(signal, "fill-supply-history");
    if (fillAbort) return fillAbort;
    const fillCount = await fillMissingSupplyHistory(db, assets, signal);
    if (fillCount > 0) {
      console.log(`[sync-stablecoins] Filled ${fillCount} missing supply changes from supply_history`);
    }
  } catch (err) {
    if (signal?.aborted) return abortResult(signal, "fill-supply-history");
    console.warn("[sync-stablecoins] supply_history fallback failed:", err);
  }

  return null;
}

function buildStalenessSummaryMetadata(staleness: {
  compared: number;
  identical: number;
}): StablecoinsStalenessSummary {
  return {
    compared: staleness.compared,
    identical: staleness.identical,
    identicalRatio:
      staleness.compared > 0
        ? Number((staleness.identical / staleness.compared).toFixed(4))
        : 0,
  };
}

export async function checkStablecoinsPriceStaleness(params: {
  db: D1Database;
  assets: PeggedAsset[];
  signal?: CronStageContext["signal"];
  reportProgress?: CronStageContext["reportProgress"];
  progressStage: string;
  progressMessage: string;
  abortStage: string;
  warningLabel?: string;
  failureLabel?: string;
  blockedResultFactory: (summary: StablecoinsStalenessSummary) => CronResult;
}): Promise<{
  stalenessWarning: boolean;
  stalenessSummary: StablecoinsStalenessSummary | null;
  blockedResult?: CronResult;
}> {
  let stalenessWarning = false;
  let stalenessSummary: StablecoinsStalenessSummary | null = null;

  try {
    await reportStablecoinsStage(
      params.reportProgress,
      params.progressStage,
      params.progressMessage,
      { itemsTotal: params.assets.length },
    );
    const stalenessAbort = returnIfAborted(params.signal, params.abortStage);
    if (stalenessAbort) {
      return {
        stalenessWarning,
        stalenessSummary,
        blockedResult: stalenessAbort,
      };
    }
    const staleness = await detectPriceStaleness(params.db, params.assets, params.signal);
    if (!staleness) {
      return { stalenessWarning, stalenessSummary };
    }

    stalenessSummary = buildStalenessSummaryMetadata(staleness);
    if (staleness.stale) {
      stalenessWarning = true;
      const label = params.warningLabel ? ` ${params.warningLabel}` : "";
      console.warn(
        `[sync-stablecoins] STALENESS WARNING${label}: ${staleness.identical}/${staleness.compared} prices ` +
        `(${(staleness.identical / staleness.compared * 100).toFixed(1)}%) are identical to previous cache`,
      );
    }

    if (
      staleness.compared >= 50 &&
      stalenessSummary.identicalRatio >= SEVERE_PRICE_STALENESS_RATIO
    ) {
      return {
        stalenessWarning,
        stalenessSummary,
        blockedResult: params.blockedResultFactory(stalenessSummary),
      };
    }
  } catch (error) {
    if (params.signal?.aborted) {
      return {
        stalenessWarning,
        stalenessSummary,
        blockedResult: abortResult(params.signal, params.abortStage),
      };
    }
    const prefix = params.failureLabel ?? "Staleness check";
    console.warn(`[sync-stablecoins] ${prefix} failed:`, error);
  }

  return { stalenessWarning, stalenessSummary };
}
