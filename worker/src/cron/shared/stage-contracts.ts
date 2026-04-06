import { reportCronProgress } from "../../lib/cron-progress";
import type { CronProgressReporter, CronResult } from "../../lib/cron-logger";

export interface CronStageContext {
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
}

export interface CronStageProgress {
  stage: string;
  message: string;
  itemsDone?: number;
  itemsTotal?: number;
  metadata?: Record<string, unknown>;
}

export interface CronStageAbortMetadata {
  reason: "aborted";
  stage: string;
  detail: string;
}

interface CronStageAbortOptions {
  signal?: AbortSignal;
  stage: string;
  serializeMetadata?: (metadata: CronStageAbortMetadata) => string;
}

export async function reportCronStage(
  reportProgress: CronProgressReporter | undefined,
  progress: CronStageProgress,
): Promise<void> {
  await reportCronProgress(reportProgress, progress);
}

export function readCronAbortReason(signal?: AbortSignal): string {
  const reasonRaw = signal?.reason;
  if (reasonRaw instanceof Error) return reasonRaw.message;
  if (typeof reasonRaw === "string" && reasonRaw.length > 0) return reasonRaw;
  return "aborted";
}

export function buildAbortedCronStageResult(options: CronStageAbortOptions): CronResult {
  const metadata: CronStageAbortMetadata = {
    reason: "aborted",
    stage: options.stage,
    detail: readCronAbortReason(options.signal),
  };

  return {
    status: "degraded",
    itemCount: 0,
    metadata: options.serializeMetadata ? options.serializeMetadata(metadata) : JSON.stringify(metadata),
  };
}

export function returnIfCronStageAborted(options: CronStageAbortOptions): CronResult | null {
  if (!options.signal?.aborted) return null;
  return buildAbortedCronStageResult(options);
}
