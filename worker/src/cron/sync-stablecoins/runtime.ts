import { buildSyncMetadata } from "./shared";
import { detectPriceStaleness, fillMissingSupplyHistory } from "./phase-helpers";
import { recordOutcome } from "../../lib/circuit-breaker";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { reportCronProgress } from "../../lib/cron-progress";
import { toErrorMessage } from "../../lib/error-utils";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";
import type { PeggedAsset } from "./enrich-prices";

const SEVERE_PRICE_STALENESS_RATIO = 0.98;

export interface StablecoinsStalenessSummary {
  compared: number;
  identical: number;
  identicalRatio: number;
}

type StablecoinsStalenessBlockedReason = "abort" | "severe-staleness";

interface StablecoinsStalenessCheckBase {
  stalenessWarning: boolean;
  stalenessCheckFailed: boolean;
  stalenessCheckFailureReason?: string;
  blockedResult?: CronResult;
  blockedReason?: StablecoinsStalenessBlockedReason;
}

export type StablecoinsStalenessCheckResult = StablecoinsStalenessCheckBase & (
  | {
      state: "ok";
      stalenessSummary: StablecoinsStalenessSummary;
      stalenessCheckFailed: false;
    }
  | {
      state: "missing-previous-cache";
      stalenessSummary: null;
      stalenessCheckFailed: false;
    }
  | {
      state: "check-failed";
      stalenessSummary: null;
      stalenessCheckFailed: true;
      stalenessCheckFailureReason: string;
    }
  | {
      state: "blocked-severe-staleness";
      stalenessSummary: StablecoinsStalenessSummary;
      stalenessCheckFailed: false;
      blockedResult: CronResult;
      blockedReason: "severe-staleness";
    }
  | {
      state: "abort";
      stalenessSummary: StablecoinsStalenessSummary | null;
      stalenessCheckFailed: false;
      blockedResult: CronResult;
      blockedReason: "abort";
    }
);

export async function reportStablecoinsStage(
  reportProgress: CronProgressReporter | undefined,
  stage: string,
  message: string,
  options?: { itemsDone?: number; itemsTotal?: number; metadata?: Record<string, unknown> },
): Promise<void> {
  await reportCronProgress(reportProgress, {
    stage,
    message,
    itemsDone: options?.itemsDone,
    itemsTotal: options?.itemsTotal,
    metadata: options?.metadata,
  });
}

function readAbortDetail(signal: AbortSignal | undefined): string {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === "string" && reason.length > 0) return reason;
  return "aborted";
}

export function abortResult(signal: AbortSignal | undefined, stage: string): CronResult {
  return {
    aborted: true,
    status: "degraded",
    itemCount: 0,
    metadata: buildSyncMetadata({ reason: "aborted", stage, detail: readAbortDetail(signal) }),
  };
}

export function returnIfAborted(signal: AbortSignal | undefined, stage: string): CronResult | null {
  if (!signal?.aborted) return null;
  return abortResult(signal, stage);
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
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
  progressStage: string;
  progressMessage: string;
  abortStage: string;
  warningLabel?: string;
  failureLabel?: string;
  blockedResultFactory: (summary: StablecoinsStalenessSummary) => CronResult;
}): Promise<StablecoinsStalenessCheckResult> {
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
        state: "abort",
        stalenessWarning,
        stalenessSummary,
        stalenessCheckFailed: false,
        blockedResult: stalenessAbort,
        blockedReason: "abort",
      };
    }
    const staleness = await detectPriceStaleness(params.db, params.assets, params.signal);
    if (staleness.state === "missing-previous-cache") {
      return {
        state: "missing-previous-cache",
        stalenessWarning,
        stalenessSummary,
        stalenessCheckFailed: false,
      };
    }
    if (staleness.state === "check-failed") {
      return {
        state: "check-failed",
        stalenessWarning,
        stalenessSummary,
        stalenessCheckFailed: true,
        stalenessCheckFailureReason: staleness.reason,
      };
    }

    stalenessSummary = buildStalenessSummaryMetadata(staleness.summary);
    if (staleness.summary.stale) {
      stalenessWarning = true;
      const label = params.warningLabel ? ` ${params.warningLabel}` : "";
      console.warn(
        `[sync-stablecoins] STALENESS WARNING${label}: ${staleness.summary.identical}/${staleness.summary.compared} prices ` +
        `(${(staleness.summary.identical / staleness.summary.compared * 100).toFixed(1)}%) are identical to previous cache`,
      );
    }

    if (
      staleness.summary.compared >= 50 &&
      stalenessSummary.identicalRatio >= SEVERE_PRICE_STALENESS_RATIO
    ) {
      return {
        state: "blocked-severe-staleness",
        stalenessWarning,
        stalenessSummary,
        stalenessCheckFailed: false,
        blockedResult: params.blockedResultFactory(stalenessSummary),
        blockedReason: "severe-staleness",
      };
    }
    return {
      state: "ok",
      stalenessWarning,
      stalenessSummary,
      stalenessCheckFailed: false,
    };
  } catch (error) {
    if (params.signal?.aborted) {
      return {
        state: "abort",
        stalenessWarning,
        stalenessSummary,
        stalenessCheckFailed: false,
        blockedResult: abortResult(params.signal, params.abortStage),
        blockedReason: "abort",
      };
    }
    const prefix = params.failureLabel ?? "Staleness check";
    console.warn(`[sync-stablecoins] ${prefix} failed:`, error);
    return {
      state: "check-failed",
      stalenessWarning,
      stalenessSummary: null,
      stalenessCheckFailed: true,
      stalenessCheckFailureReason: toErrorMessage(error),
    };
  }
}

export async function recordStablecoinsStalenessBlockOutcome(
  db: D1Database,
  check: Pick<StablecoinsStalenessCheckResult, "blockedReason">,
): Promise<void> {
  if (check.blockedReason !== "severe-staleness") return;
  await recordOutcome(db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
}
