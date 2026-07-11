import type { D1CapacityAssessment } from "@shared/types/status";
import type { CloudflareD1StatusConfig } from "../env";
import { deliverOperationalAlert } from "../operational-alert";
import { logWorkerEvent } from "../structured-log";
import { getD1CapacityAssessmentFromCloudflare } from "./d1-usage";

const D1_CAPACITY_CONDITION_KEY = "d1:capacity-threshold";
const D1_CAPACITY_OBSERVATION_CONDITION_KEY = "d1:capacity-observation-unavailable";

export interface D1CapacityMonitoringResult {
  assessment: D1CapacityAssessment | null;
  error: string | null;
}

function forecastMessage(assessment: D1CapacityAssessment): string {
  if (assessment.daysUntilExhaustion != null && assessment.exhaustionAt != null) {
    return `Forecast exhaustion in ${assessment.daysUntilExhaustion} days (${new Date(assessment.exhaustionAt * 1000).toISOString()}).`;
  }
  if (assessment.forecastBasis === "non-growing") {
    return "The 30-day size trend is flat or shrinking.";
  }
  return `Forecast unavailable: ${assessment.sampleCount} sample(s) across ${assessment.forecastSpanHours} hours.`;
}

export function buildD1CapacityAlertPolicy(assessment: D1CapacityAssessment) {
  const active = assessment.thresholdState !== "normal";
  return {
    active,
    severity: assessment.thresholdState === "critical" ? "critical" as const : "warning" as const,
    title: active
      ? `D1 capacity ${assessment.thresholdState}: ${assessment.utilizationPercent}% used`
      : "D1 capacity returned below the watch threshold",
    message: `${assessment.databaseSizeBytes} of ${assessment.maximumSizeBytes} bytes used. ${forecastMessage(assessment)}`,
    fingerprint: { thresholdState: assessment.thresholdState },
    metadata: {
      utilizationPercent: assessment.utilizationPercent,
      thresholdState: assessment.thresholdState,
      crossedThresholdPercent: assessment.crossedThresholdPercent,
      nextThresholdPercent: assessment.nextThresholdPercent,
      growthBytesPerDay: assessment.growthBytesPerDay,
      nextThresholdAt: assessment.nextThresholdAt,
      exhaustionAt: assessment.exhaustionAt,
      daysUntilExhaustion: assessment.daysUntilExhaustion,
      observedAt: assessment.observedAt,
    },
  };
}

async function reportObservationAvailability(
  db: D1Database,
  active: boolean,
  options: {
    brokerMode: string;
    webhookUrl?: string | null;
    error?: string | null;
  },
): Promise<void> {
  await deliverOperationalAlert({
    db,
    conditionKey: D1_CAPACITY_OBSERVATION_CONDITION_KEY,
    active,
    severity: "warning",
    title: "D1 capacity observation unavailable",
    message: options.error ?? "The Cloudflare D1 database-size observation failed.",
    recoveryTitle: "D1 capacity observations recovered",
    recoveryMessage: "The Cloudflare D1 database-size observation succeeded again.",
    fingerprint: { source: "cloudflare-d1-control-plane" },
    metadata: options.error ? { error: options.error.slice(0, 500) } : undefined,
    webhookUrl: options.webhookUrl,
    brokerMode: options.brokerMode,
    minStreak: 3,
  });
}

export async function refreshD1CapacityMonitoring(
  db: D1Database,
  config: CloudflareD1StatusConfig,
  nowSeconds: number,
  options: {
    brokerMode?: string;
    webhookUrl?: string | null;
  } = {},
): Promise<D1CapacityMonitoringResult> {
  let assessment: D1CapacityAssessment | null;
  try {
    assessment = await getD1CapacityAssessmentFromCloudflare(config, db, nowSeconds);
    if (!assessment) throw new Error("Cloudflare D1 database info omitted file_size");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWorkerEvent({
      scope: "status",
      level: "warn",
      event: "d1_capacity_monitor_failed",
      job: "status-self-check",
      source: "cloudflare-d1-status",
      message: "D1 capacity monitor failed",
      error,
    });
    if (options.brokerMode != null) {
      await reportObservationAvailability(db, true, {
        brokerMode: options.brokerMode,
        webhookUrl: options.webhookUrl,
        error: message,
      });
    }
    return { assessment: null, error: message };
  }

  if (options.brokerMode != null) {
    await reportObservationAvailability(db, false, {
      brokerMode: options.brokerMode,
      webhookUrl: options.webhookUrl,
    });
    const policy = buildD1CapacityAlertPolicy(assessment);
    await deliverOperationalAlert({
      db,
      conditionKey: D1_CAPACITY_CONDITION_KEY,
      active: policy.active,
      severity: policy.severity,
      title: policy.title,
      message: policy.message,
      recoveryTitle: "D1 capacity returned below 60%",
      recoveryMessage: "D1 database utilization is below the 60% watch threshold again.",
      fingerprint: policy.fingerprint,
      metadata: policy.metadata,
      webhookUrl: options.webhookUrl,
      brokerMode: options.brokerMode,
    });
  }

  return { assessment, error: null };
}
