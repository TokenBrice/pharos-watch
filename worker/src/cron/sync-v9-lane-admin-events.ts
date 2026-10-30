import { z } from "zod";
import {
  V9_LANE_SCREENING_FAILURE_REASON_VALUES,
  type V9LaneIncidentCertificate,
  type V9LaneScreeningFailureReason,
} from "@shared/types/safety-score-v9-incidents";
import { isWellFormedDeploymentId } from "@shared/types/deployment-id";
import { throwIfAborted } from "../lib/abort";
import type { ChainRpcConfig } from "../lib/chain-registry";
import type { CronResult } from "../lib/cron-logger";
import { createCronResult, createNeutralSkippedCronResult, type CronMetadataValue } from "../lib/cron-result";
import { getCaches, setCacheIfNewer } from "../lib/db-cache";
import { fetchEvmBlockHeaderAtTag, type EvmBlockHeader } from "../lib/evm-rpc";
import {
  LANE_ADMIN_EVENT_DEFAULT_LOG_PAGE_BLOCKS,
  LANE_ADMIN_EVENT_MAX_LOG_PAGES,
  LaneScreeningDeadlineError,
  screenLaneAdminEvents,
  type LaneAdminEventEmitter,
  type LaneAdminEventScreeningTarget,
} from "../lib/safety-score-v9/bridge-lane-admin-events";
import {
  loadLaneIncidentCertificates,
  persistLaneIncidentCertificates,
} from "../lib/safety-score-v9/lane-incident-certificate-store";

/**
 * Shadow producer for bridge-lane admin-event certificates (PLAN §4.7 IR-3c).
 *
 * The job is a driver only: it selects due EVM lanes from a reviewed descriptor
 * catalog, screens them one at a time (one JSON-RPC connection in flight), and
 * hands admitted C3 certificates to the IR-3b store. Nothing here is admitted to
 * scoring; the certificates stay write-only until the v10.38 admission consumer
 * (`extension-incidents.ts`, IR-1c) reads them.
 *
 * Budget rules (six-connection operating assumption):
 * - one lane is screened at a time (`screenLaneAdminEvents` issues one batch and
 *   waits), so this job never contributes more than one outbound connection;
 * - a lane that already failed in this invocation is never retried (an attempt is
 *   written per lane, including the machine reason);
 * - `LANE_SCREENING_MAX_LANES_PER_INVOCATION` bounds how many lanes one trigger
 *   may touch, and each certificate is capped at
 *   `LANE_SCREENING_MAX_BLOCKS_PER_CERTIFICATE` blocks (the screener's own page
 *   cap), so a lane behind the head advances in chained certificates across
 *   invocations instead of overrunning one.
 *
 * Failure state is owned here (one cache row per lane) because the certificate
 * store persists admitted certificates only. A failed or stale lane never gains
 * a certificate: the datum stays `unknown` (ADR-29).
 */

/** One cache row per lane; the store is the certificate authority, this is the attempt log. */
export const LANE_SCREENING_ATTEMPT_CACHE_PREFIX = "v9:lane-screening:attempt:v1:";

/** Per-invocation lane cap. Eight lanes bound a run to at most 8 x 34 RPC batches. */
export const LANE_SCREENING_MAX_LANES_PER_INVOCATION = 8;
/** A lane is not re-attempted inside this window, which makes a rerun of the same slot a no-op. */
export const LANE_SCREENING_REFRESH_INTERVAL_SEC = 60 * 60;
/** First failure backoff; consecutive failures double it up to the ceiling. */
export const LANE_SCREENING_FAILURE_BACKOFF_SEC = 6 * 60 * 60;
export const LANE_SCREENING_MAX_FAILURE_BACKOFF_SEC = 24 * 60 * 60;
/** The screener's own page cap x its default page span: one chained certificate per invocation. */
export const LANE_SCREENING_MAX_BLOCKS_PER_CERTIFICATE =
  LANE_ADMIN_EVENT_MAX_LOG_PAGES * LANE_ADMIN_EVENT_DEFAULT_LOG_PAGE_BLOCKS;
/** Per-batch RPC timeout passed to the screener and to the finalized-head read. */
export const LANE_SCREENING_RPC_TIMEOUT_MS = 10_000;
/** D1's bound-parameter limit for one cache read. */
const ATTEMPT_READ_BATCH_SIZE = 100;
const MAX_DETAIL_LENGTH = 240;

/**
 * One reviewed lane descriptor. `emitters[].expectedRuntimeCodeSha256` is the
 * reviewed runtime pin from the emitter inventory (hash of decoded runtime
 * bytes, the IR-3a convention); this job never derives a pin from an observation.
 */
export interface LaneScreeningDescriptor {
  /** Normalized lane/controller deployment (`chain:contractAddress`). */
  subjectDeploymentKey: string;
  /** Every contract whose admin events this lane depends on; at least one. */
  emitters: readonly LaneAdminEventEmitter[];
  /** Bootstrap range length (blocks) when the lane has no certificate yet. */
  lookbackBlocks: number;
}

export const LaneScreeningAttemptSchema = z
  .object({
    subjectDeploymentKey: z.string().min(3).max(256),
    attemptedAtSec: z.number().int().nonnegative(),
    fromBlock: z.number().int().nonnegative(),
    toBlock: z.number().int().nonnegative(),
    outcome: z.enum(["admitted", "failed", "store-error", "deferred"]),
    certificateId: z.string().min(1).max(256).optional(),
    failureReason: z.enum(V9_LANE_SCREENING_FAILURE_REASON_VALUES).optional(),
    detail: z.string().min(1).max(MAX_DETAIL_LENGTH).optional(),
    reason: z.literal("deadline").optional(),
    consecutiveFailures: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    if (attempt.toBlock < attempt.fromBlock) {
      ctx.addIssue({ code: "custom", path: ["toBlock"], message: "Attempt window must end at or after its start" });
    }
    if (attempt.outcome === "admitted") {
      if (attempt.certificateId == null) {
        ctx.addIssue({ code: "custom", path: ["certificateId"], message: "An admitted attempt names its certificate" });
      }
      if (attempt.failureReason != null || attempt.reason != null) {
        ctx.addIssue({ code: "custom", path: ["failureReason"], message: "An admitted attempt carries no failure or deferral reason" });
      }
      return;
    }
    if (attempt.outcome === "deferred") {
      if (attempt.reason !== "deadline" || attempt.failureReason != null || attempt.consecutiveFailures !== 0) {
        ctx.addIssue({ code: "custom", path: ["reason"], message: "A deferred attempt names deadline without failure backoff" });
      }
    } else if (attempt.reason != null) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "Only a deferred attempt carries a deferral reason" });
    }
    if (attempt.certificateId != null) {
      ctx.addIssue({ code: "custom", path: ["certificateId"], message: "A non-admitted attempt carries no certificate" });
    }
    if (attempt.outcome === "failed" && attempt.failureReason == null) {
      ctx.addIssue({ code: "custom", path: ["failureReason"], message: "A failed attempt names its machine reason" });
    }
  });
export type LaneScreeningAttempt = z.output<typeof LaneScreeningAttemptSchema>;

export type LaneScreeningDeferralReason =
  | "duplicate-descriptor"
  | "invalid-descriptor"
  | "unsupported-chain"
  | "failure-backoff"
  | "not-due"
  | "certificate-coverage-gap"
  | "certificate-malformed"
  | "certificate-future-window"
  | "deadline"
  | "current";

export interface LaneScreeningDeferral {
  subjectDeploymentKey: string;
  reason: LaneScreeningDeferralReason;
}

/** Machine reasons a lane produced no certificate in this invocation. */
export type LaneScreeningOutcomeReason = V9LaneScreeningFailureReason | "certificate-store-write-failed" | "rpc-unavailable" | "deadline";

export interface LaneScreeningLaneOutcome {
  subjectDeploymentKey: string;
  outcome: "admitted" | "failed" | "deferred";
  reason?: LaneScreeningOutcomeReason;
  detail?: string;
  fromBlock?: number;
  toBlock?: number;
  certificateId?: string;
}

export interface SyncLaneAdminEventsOptions {
  /** Reviewed lane catalog; absent/empty means the emitter inventory has not been authored yet. */
  descriptors?: readonly LaneScreeningDescriptor[];
  /** Producer clock override (tests, replays). */
  observedAtSec?: number;
  maxLanesPerInvocation?: number;
  refreshIntervalSec?: number;
  failureBackoffSec?: number;
  timeoutMs?: number;
  /** Absolute RPC deadline; no new lane or batch starts without one request's budget. */
  deadlineMs?: number;
}

export function laneScreeningAttemptCacheKey(subjectDeploymentKey: string): string {
  return `${LANE_SCREENING_ATTEMPT_CACHE_PREFIX}${subjectDeploymentKey}`;
}

export function parseLaneScreeningAttempt(value: string): LaneScreeningAttempt | null {
  try {
    const parsed = LaneScreeningAttemptSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function failureBackoffSec(consecutiveFailures: number, baseSec: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(baseSec * 2 ** Math.min(consecutiveFailures - 1, 8), LANE_SCREENING_MAX_FAILURE_BACKOFF_SEC);
}

function sanitizeDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const compact = detail.replace(/\s+/gu, " ").trim();
  return compact.length === 0 ? undefined : compact.slice(0, MAX_DETAIL_LENGTH);
}

/**
 * Pure pre-screen selection: validates and dedupes descriptors, drops non-EVM
 * chains, lanes inside their failure/refresh window, and lanes whose certificate
 * chain needs a data repair rather than another window. The result is ordered
 * least-recently-attempted first so a capped invocation rotates through the
 * catalog instead of re-screening the same lanes.
 */
export function selectLaneScreeningCandidates(input: {
  descriptors: readonly LaneScreeningDescriptor[];
  attempts: ReadonlyMap<string, LaneScreeningAttempt>;
  certificateStates: ReadonlyMap<string, string>;
  chainTypes: ReadonlyMap<string, ChainRpcConfig["type"]>;
  nowSec: number;
  refreshIntervalSec?: number;
  failureBackoffSec?: number;
}): { candidates: LaneScreeningDescriptor[]; deferred: LaneScreeningDeferral[] } {
  const refreshIntervalSec = input.refreshIntervalSec ?? LANE_SCREENING_REFRESH_INTERVAL_SEC;
  const baseFailureBackoffSec = input.failureBackoffSec ?? LANE_SCREENING_FAILURE_BACKOFF_SEC;
  const deferred: LaneScreeningDeferral[] = [];
  const seen = new Set<string>();
  const candidates: LaneScreeningDescriptor[] = [];
  for (const descriptor of input.descriptors) {
    const key = descriptor.subjectDeploymentKey;
    if (seen.has(key)) {
      deferred.push({ subjectDeploymentKey: key, reason: "duplicate-descriptor" });
      continue;
    }
    seen.add(key);
    if (
      !isWellFormedDeploymentId(key) ||
      !Number.isSafeInteger(descriptor.lookbackBlocks) ||
      descriptor.lookbackBlocks < 1 ||
      descriptor.emitters.length === 0
    ) {
      deferred.push({ subjectDeploymentKey: key, reason: "invalid-descriptor" });
      continue;
    }
    const chainId = key.slice(0, key.indexOf(":"));
    if (input.chainTypes.get(chainId) !== "evm") {
      deferred.push({ subjectDeploymentKey: key, reason: "unsupported-chain" });
      continue;
    }
    const attempt = input.attempts.get(key);
    if (attempt && attempt.outcome !== "admitted") {
      const backoffSec = failureBackoffSec(attempt.consecutiveFailures, baseFailureBackoffSec);
      if (input.nowSec < attempt.attemptedAtSec + backoffSec) {
        deferred.push({ subjectDeploymentKey: key, reason: "failure-backoff" });
        continue;
      }
    }
    if (attempt && attempt.outcome !== "deferred" && input.nowSec < attempt.attemptedAtSec + refreshIntervalSec) {
      deferred.push({ subjectDeploymentKey: key, reason: "not-due" });
      continue;
    }
    const state = input.certificateStates.get(key);
    if (state === "coverage-gap") {
      deferred.push({ subjectDeploymentKey: key, reason: "certificate-coverage-gap" });
      continue;
    }
    if (state === "malformed-row") {
      deferred.push({ subjectDeploymentKey: key, reason: "certificate-malformed" });
      continue;
    }
    if (state === "future-window") {
      deferred.push({ subjectDeploymentKey: key, reason: "certificate-future-window" });
      continue;
    }
    candidates.push(descriptor);
  }
  candidates.sort((left, right) => {
    const leftAt = input.attempts.get(left.subjectDeploymentKey)?.attemptedAtSec ?? -1;
    const rightAt = input.attempts.get(right.subjectDeploymentKey)?.attemptedAtSec ?? -1;
    return leftAt - rightAt || left.subjectDeploymentKey.localeCompare(right.subjectDeploymentKey);
  });
  return { candidates, deferred };
}

/**
 * One chained certificate window. The store's chain rule is block-contiguous
 * (`next.fromBlock <= coveredThroughBlock + 1`), so the next range starts one
 * block after the newest certified `toBlock`. Without a certificate the
 * descriptor lookback bootstraps the lane. Returns null when the lane already
 * reaches the finalized head, so a rerun of the same slot screens nothing.
 */
export function planLaneScreeningWindow(input: {
  descriptor: LaneScreeningDescriptor;
  finalizedHead: EvmBlockHeader;
  certifiedToBlock: number | null;
}): { fromBlock: number; toBlock: number } | null {
  const headNumber = input.finalizedHead.number;
  const fromBlock =
    input.certifiedToBlock == null
      ? Math.max(0, headNumber - input.descriptor.lookbackBlocks + 1)
      : input.certifiedToBlock + 1;
  if (fromBlock > headNumber) return null;
  return {
    fromBlock,
    toBlock: Math.min(headNumber, fromBlock + LANE_SCREENING_MAX_BLOCKS_PER_CERTIFICATE - 1),
  };
}

function nextConsecutiveFailures(attempt: LaneScreeningAttempt | undefined): number {
  return attempt && (attempt.outcome === "failed" || attempt.outcome === "store-error") ? attempt.consecutiveFailures + 1 : 1;
}

async function readAttempts(
  db: D1Database,
  keys: readonly string[],
): Promise<{ attempts: Map<string, LaneScreeningAttempt>; malformed: number }> {
  const attempts = new Map<string, LaneScreeningAttempt>();
  let malformed = 0;
  for (let offset = 0; offset < keys.length; offset += ATTEMPT_READ_BATCH_SIZE) {
    const batch = keys.slice(offset, offset + ATTEMPT_READ_BATCH_SIZE);
    const cacheKeys = batch.map(laneScreeningAttemptCacheKey);
    const rows = await getCaches(db, cacheKeys);
    for (let index = 0; index < batch.length; index += 1) {
      const row = rows.get(cacheKeys[index]!);
      if (!row) continue;
      const attempt = parseLaneScreeningAttempt(row.value);
      if (attempt) attempts.set(batch[index]!, attempt);
      else malformed += 1;
    }
  }
  return { attempts, malformed };
}

function countDeferrals(deferred: readonly LaneScreeningDeferral[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of deferred) counts[row.reason] = (counts[row.reason] ?? 0) + 1;
  return counts;
}

/**
 * Screen the due lanes in shadow. Certificates go to the IR-3b store; failures
 * and last attempts go to this job's cache row family (no certificate is written
 * for a failed lane).
 */
export async function syncV9LaneAdminEvents(
  db: D1Database,
  chainRpcs: Map<string, ChainRpcConfig>,
  signal?: AbortSignal,
  options: SyncLaneAdminEventsOptions = {},
): Promise<CronResult> {
  const nowSec = options.observedAtSec ?? Math.floor(Date.now() / 1_000);
  const descriptors = options.descriptors ?? [];
  if (descriptors.length === 0) {
    return createNeutralSkippedCronResult("no-lane-descriptors", {
      catalog: 0,
      note: "the reviewed lane emitter inventory has not been authored yet",
    });
  }
  throwIfAborted(signal);

  const laneKeys = [...new Set(descriptors.map((descriptor) => descriptor.subjectDeploymentKey))];
  const { attempts, malformed } = await readAttempts(db, laneKeys);
  throwIfAborted(signal);

  let certificateStates: Map<string, string>;
  let certifiedToBlock: Map<string, number>;
  try {
    const states = await loadLaneIncidentCertificates(db, laneKeys, { nowSec, signal });
    certificateStates = new Map();
    certifiedToBlock = new Map();
    for (const key of laneKeys) {
      const read = states.get(key);
      if (!read) continue;
      certificateStates.set(key, read.state);
      // The store is the chain authority: the newest retained certificate's toBlock
      // is the only block the next window may start from.
      if (read.state !== "missing" && read.state !== "malformed-row") {
        certifiedToBlock.set(key, read.certificate.toBlock);
      }
    }
  } catch {
    return createCronResult({
      status: "degraded",
      itemCount: 0,
      metadata: {
        reason: "lane-certificate-store-read-failed",
        catalog: descriptors.length,
      },
    });
  }

  const chainTypes = new Map<string, ChainRpcConfig["type"]>();
  for (const [chainId, config] of chainRpcs) chainTypes.set(chainId, config.type);

  const { candidates, deferred } = selectLaneScreeningCandidates({
    descriptors,
    attempts,
    certificateStates,
    chainTypes,
    nowSec,
    ...(options.refreshIntervalSec === undefined ? {} : { refreshIntervalSec: options.refreshIntervalSec }),
    ...(options.failureBackoffSec === undefined ? {} : { failureBackoffSec: options.failureBackoffSec }),
  });

  const laneCap = Math.max(1, options.maxLanesPerInvocation ?? LANE_SCREENING_MAX_LANES_PER_INVOCATION);
  const timeoutMs = options.timeoutMs ?? LANE_SCREENING_RPC_TIMEOUT_MS;
  const outcomes: LaneScreeningLaneOutcome[] = [];
  const finalizedHeads = new Map<string, EvmBlockHeader | null>();
  let attempted = 0;
  let admitted = 0;
  let failed = 0;
  let written = 0;
  let pruned = 0;
  let deadlineExhausted = false;

  const deferDeadline = async (key: string, window = { fromBlock: 0, toBlock: 0 }) => {
    deadlineExhausted = true;
    const attempt: LaneScreeningAttempt = {
      subjectDeploymentKey: key, attemptedAtSec: nowSec, ...window,
      outcome: "deferred", reason: "deadline", consecutiveFailures: 0,
    };
    await setCacheIfNewer(db, laneScreeningAttemptCacheKey(key), JSON.stringify(attempt), nowSec, signal);
    attempts.set(key, attempt);
    deferred.push({ subjectDeploymentKey: key, reason: "deadline" });
    outcomes.push({ subjectDeploymentKey: key, outcome: "deferred", reason: "deadline", ...window });
  };

  for (const descriptor of candidates) {
    if (attempted >= laneCap) break;
    if (options.deadlineMs !== undefined && options.deadlineMs - Date.now() < timeoutMs) {
      attempted += 1;
      await deferDeadline(descriptor.subjectDeploymentKey);
      break;
    }
    throwIfAborted(signal);
    const key = descriptor.subjectDeploymentKey;
    const chainId = key.slice(0, key.indexOf(":"));
    let finalizedHead = finalizedHeads.get(chainId);
    if (finalizedHead === undefined) {
      try {
        finalizedHead = await fetchEvmBlockHeaderAtTag(chainId, "finalized", {
          chainRpcs,
          signal,
          timeoutMs: Math.min(timeoutMs, options.deadlineMs === undefined ? timeoutMs : options.deadlineMs - Date.now()),
          deadlineMs: options.deadlineMs,
        });
      } catch {
        finalizedHead = null;
      }
      finalizedHeads.set(chainId, finalizedHead);
    }
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs) {
      attempted += 1;
      await deferDeadline(key);
      break;
    }
    if (!finalizedHead) {
      attempted += 1;
      failed += 1;
      const attempt: LaneScreeningAttempt = {
        subjectDeploymentKey: key,
        attemptedAtSec: nowSec,
        fromBlock: 0,
        toBlock: 0,
        outcome: "failed",
        failureReason: "rpc-unavailable",
        detail: "finalized-head",
        consecutiveFailures: nextConsecutiveFailures(attempts.get(key)),
      };
      await setCacheIfNewer(db, laneScreeningAttemptCacheKey(key), JSON.stringify(attempt), nowSec, signal);
      attempts.set(key, attempt);
      outcomes.push({ subjectDeploymentKey: key, outcome: "failed", reason: "rpc-unavailable", detail: "finalized-head" });
      continue;
    }

    const window = planLaneScreeningWindow({
      descriptor,
      finalizedHead,
      certifiedToBlock: certifiedToBlock.get(key) ?? null,
    });
    if (!window) {
      deferred.push({ subjectDeploymentKey: key, reason: "current" });
      continue;
    }

    attempted += 1;
    const target: LaneAdminEventScreeningTarget = {
      subjectDeploymentKey: descriptor.subjectDeploymentKey,
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
      emitters: descriptor.emitters,
    };
    let result;
    try {
      result = await screenLaneAdminEvents(target, {
        chainRpcs,
        signal,
        timeoutMs,
        deadlineMs: options.deadlineMs,
        observedAtSec: nowSec,
      });
    } catch (error) {
      if (!(error instanceof LaneScreeningDeadlineError)) throw error;
      await deferDeadline(key, window);
      break;
    }
    if (result.outcome === "failed") {
      failed += 1;
      const attempt: LaneScreeningAttempt = {
        subjectDeploymentKey: key,
        attemptedAtSec: nowSec,
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
        outcome: "failed",
        failureReason: result.failureReason,
        ...(sanitizeDetail(result.detail) === undefined ? {} : { detail: sanitizeDetail(result.detail) }),
        consecutiveFailures: nextConsecutiveFailures(attempts.get(key)),
      };
      await setCacheIfNewer(db, laneScreeningAttemptCacheKey(key), JSON.stringify(attempt), nowSec, signal);
      attempts.set(key, attempt);
      outcomes.push({
        subjectDeploymentKey: key,
        outcome: "failed",
        reason: result.failureReason,
        ...(sanitizeDetail(result.detail) === undefined ? {} : { detail: sanitizeDetail(result.detail) }),
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
      });
      continue;
    }

    const certificate: V9LaneIncidentCertificate = result.certificate;
    try {
      const persisted = await persistLaneIncidentCertificates(db, [certificate], nowSec, signal);
      written += persisted.written;
      pruned += persisted.pruned;
    } catch {
      failed += 1;
      const attempt: LaneScreeningAttempt = {
        subjectDeploymentKey: key,
        attemptedAtSec: nowSec,
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
        outcome: "store-error",
        detail: "certificate-store-write-failed",
        consecutiveFailures: nextConsecutiveFailures(attempts.get(key)),
      };
      await setCacheIfNewer(db, laneScreeningAttemptCacheKey(key), JSON.stringify(attempt), nowSec, signal);
      attempts.set(key, attempt);
      outcomes.push({
        subjectDeploymentKey: key,
        outcome: "failed",
        reason: "certificate-store-write-failed",
        fromBlock: window.fromBlock,
        toBlock: window.toBlock,
      });
      // A write failure is systemic; stop instead of spending the rest of the budget on certificates that cannot land.
      break;
    }
    admitted += 1;
    const attempt: LaneScreeningAttempt = {
      subjectDeploymentKey: key,
      attemptedAtSec: nowSec,
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
      outcome: "admitted",
      certificateId: certificate.certificateId,
      consecutiveFailures: 0,
    };
    await setCacheIfNewer(db, laneScreeningAttemptCacheKey(key), JSON.stringify(attempt), nowSec, signal);
    attempts.set(key, attempt);
    outcomes.push({
      subjectDeploymentKey: key,
      outcome: "admitted",
      fromBlock: window.fromBlock,
      toBlock: window.toBlock,
      certificateId: certificate.certificateId,
    });
  }

  const deferredCounts = countDeferrals(deferred);
  const deferredByCap = Math.max(0, candidates.length - attempted);
  const laneMetadata: CronMetadataValue = outcomes.map((row) => ({
    subjectDeploymentKey: row.subjectDeploymentKey,
    outcome: row.outcome,
    ...(row.reason === undefined ? {} : { reason: row.reason }),
    ...(row.detail === undefined ? {} : { detail: row.detail }),
    ...(row.fromBlock === undefined ? {} : { fromBlock: row.fromBlock }),
    ...(row.toBlock === undefined ? {} : { toBlock: row.toBlock }),
    ...(row.certificateId === undefined ? {} : { certificateId: row.certificateId }),
  }));
  const metadata = {
    catalog: descriptors.length,
    candidates: candidates.length,
    attempted,
    admitted,
    failed,
    deferredByCap,
    certificatesWritten: written,
    certificatesPruned: pruned,
    malformedAttempts: malformed,
    deferred: deferredCounts,
    laneCap,
    refreshIntervalSec: options.refreshIntervalSec ?? LANE_SCREENING_REFRESH_INTERVAL_SEC,
    failureBackoffSec: options.failureBackoffSec ?? LANE_SCREENING_FAILURE_BACKOFF_SEC,
    maxBlocksPerCertificate: LANE_SCREENING_MAX_BLOCKS_PER_CERTIFICATE,
    deadlineExhausted,
    lanes: laneMetadata,
  };

  if (attempted === 0 && admitted === 0) {
    return createNeutralSkippedCronResult("no-due-lanes", metadata);
  }
  if (failed > 0) {
    return createCronResult({
      status: "degraded",
      itemCount: admitted,
      metadata: { ...metadata, reason: "lane-screening-failures" },
    });
  }
  return createCronResult({ status: "ok", itemCount: admitted, metadata });
}
