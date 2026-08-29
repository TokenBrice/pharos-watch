import { toErrorMessage } from "@shared/lib/error-utils";
import type { D1CapacityAssessment } from "@shared/types/status";
import type { CloudflareD1StatusConfig } from "../env";
import { logWorkerEvent } from "../structured-log";
import { getD1CapacityAssessmentFromCloudflare } from "./d1-usage";

export interface D1CapacityMonitoringResult {
  assessment: D1CapacityAssessment | null;
  error: string | null;
}

export async function refreshD1CapacityMonitoring(
  db: D1Database,
  config: CloudflareD1StatusConfig,
  nowSeconds: number,
): Promise<D1CapacityMonitoringResult> {
  let assessment: D1CapacityAssessment | null;
  try {
    assessment = await getD1CapacityAssessmentFromCloudflare(config, db, nowSeconds);
    if (!assessment) throw new Error("Cloudflare D1 database info omitted file_size");
  } catch (error) {
    const message = toErrorMessage(error);
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "d1_capacity_monitor_failed",
      job: "status-self-check",
      source: "cloudflare-d1-status",
      message: "D1 capacity monitor failed",
      error,
    });
    return { assessment: null, error: message };
  }

  return { assessment, error: null };
}
