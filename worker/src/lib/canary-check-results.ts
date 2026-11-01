import { toErrorMessage } from "@shared/lib/error-utils";
import type { CanaryExecutionStatus, CanaryRunSeverity, CanaryRunStatus } from "@shared/types/status";

/** Shared constructors for the CANARY_CHECKS cohort. */
export interface CanaryCheckOutcome {
  status: CanaryRunStatus;
  severity: CanaryRunSeverity;
  executionStatus: CanaryExecutionStatus;
  executionFailureReason: string | null;
  metadata?: Record<string, unknown>;
  error?: string | null;
}

export const MAX_CANARY_ERROR_CHARS = 800;

export function boundedText(value: string, maxChars = MAX_CANARY_ERROR_CHARS): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

export function okResult(metadata?: Record<string, unknown>): CanaryCheckOutcome {
  return {
    status: "ok",
    severity: "info",
    executionStatus: "completed",
    executionFailureReason: null,
    metadata,
  };
}

export function degradedResult(error: string, metadata?: Record<string, unknown>): CanaryCheckOutcome {
  return {
    status: "degraded",
    severity: "warning",
    executionStatus: "completed",
    executionFailureReason: null,
    error,
    metadata,
  };
}

export function errorResult(error: string, metadata?: Record<string, unknown>): CanaryCheckOutcome {
  return {
    status: "error",
    severity: "error",
    executionStatus: "completed",
    executionFailureReason: null,
    error,
    metadata,
  };
}

export function skippedResult(reason: string, metadata?: Record<string, unknown>): CanaryCheckOutcome {
  return {
    status: "skipped",
    severity: "info",
    executionStatus: "completed",
    executionFailureReason: null,
    error: reason,
    metadata,
  };
}

export function failedResult(reason: string, metadata?: Record<string, unknown>): CanaryCheckOutcome {
  return { ...errorResult(reason, metadata), executionStatus: "failed", executionFailureReason: reason };
}

export function unavailableResult(error: unknown): CanaryCheckOutcome {
  return failedResult("canary-source-unavailable", { error: boundedText(toErrorMessage(error)) });
}
