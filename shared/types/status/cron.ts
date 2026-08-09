import { z } from "zod";

export const CRON_RUN_STATUS_VALUES = [
  "ok",
  "degraded",
  "error",
  "skipped_locked",
  "skipped_neutral",
  "skipped_duplicate",
  "skipped_running",
] as const;
export const CronRunStatusSchema = z.enum(CRON_RUN_STATUS_VALUES);
export type CronRunStatus = z.infer<typeof CronRunStatusSchema>;

export interface CronRun {
  startedAt: number;
  durationMs: number;
  status: CronRunStatus;
  error?: string;
  itemCount?: number;
  metadata?: Record<string, unknown>;
}

export interface CronInFlight {
  startedAt: number;
  updatedAt: number;
  stage?: string;
  itemsDone?: number;
  itemsTotal?: number;
  message?: string;
  leaseOwner?: string;
  metadata?: Record<string, unknown>;
  stale: boolean;
}

export interface CronStaleArtifact {
  kind: "expired-lease" | "orphaned-progress";
  job: string;
  leaseOwner?: string;
  leaseUntil?: number;
  progressUpdatedAt?: number;
  progressStage?: string;
  slotStartedAt?: number | null;
}

export interface CronEvent {
  event: "cron_event";
  job: string;
  eventType: string;
  severity: "info" | "warning" | "error";
  message: string;
  metadata?: Record<string, unknown>;
  recordedAt: number;
}

export interface CronStatus {
  lastRun: CronRun | null;
  recentRuns: CronRun[];
  expectedIntervalSec: number;
  healthy: boolean;
  telemetryUnknown?: boolean;
  inFlight?: CronInFlight | null;
  staleArtifacts?: CronStaleArtifact[];
  latestEvent?: CronEvent;
  /**
   * Set to `true` only for watch-tier crons that have zero historical runs
   * (bootstrap state). The cron is considered healthy in this state because
   * its first successful run has not yet produced a `cron_runs` row, so
   * there is no history to compare against. Critical-tier crons do not get
   * this flag — they are unhealthy until they have produced at least one run.
   */
  bootstrap?: boolean;
}

export interface BudgetOnlySurfaceStatus {
  job: string;
  label: string;
  scheduleKey: string;
  schedule: string;
  expectedIntervalSec: number;
  maxAgeSec: number;
  maxConnections: number;
  connectionGroup?: string;
  telemetryStatus: "fresh" | "stale" | "missing" | "unreadable";
  telemetryUnknown: boolean;
  checkedAt: number | null;
  ageSeconds: number | null;
  durationMs: number | null;
  dueCount: number | null;
  processedCount: number | null;
  outcome: "ok" | "degraded" | "error" | "skipped" | "unknown";
  skippedReason?: string | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
}
