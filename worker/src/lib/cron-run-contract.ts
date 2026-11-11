import type { PublicationSurfaceId } from "@shared/types/status";
import type { CronResultStatus } from "@shared/types/status/cron";

export interface CronPublicationRecord {
  surface: PublicationSurfaceId;
  generationId: string;
  publishedAt: number;
  candidateRows?: number | null;
  publishedRows?: number | null;
  expectedRows?: number | null;
  artifactCacheKey?: string | null;
  artifactChecksum?: string | null;
  inputWatermarks?: Record<string, unknown> | null;
  validationSummary?: Record<string, unknown> | null;
}

export interface CronProductivity {
  productive: boolean;
  reason?: string;
  publications?: readonly CronPublicationRecord[];
}

export interface CronResult {
  itemCount?: number;
  metadata?: string;
  status?: CronResultStatus;
  /** Human-readable failure summary persisted to cron_runs.error when present; preferred over metadata in the alert body for "error" statuses. */
  error?: string;
  /**
   * Affirmative discriminant set only on results produced by the cron-stage
   * abort builders (see `abortResult` in `sync-stablecoins/runtime.ts`). Lets `isAbortResult`
   * identify the abort sentinel without relying on the absence of fields from
   * other stage result shapes.
   */
  aborted?: true;
  /** Explicit productive-output/publication contract for durable producer history. */
  productivity?: CronProductivity;
  /** Job opt-in: only confirmed committed publication evidence may survive a settled abort. */
  abortResultPolicy?: "preserve-committed-publication";
}


export interface CronProgressUpdate {
  stage?: string | null;
  itemsDone?: number | null;
  itemsTotal?: number | null;
  message?: string | null;
  leaseOwner?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type CronProgressReporter = (update: CronProgressUpdate) => Promise<void>;

