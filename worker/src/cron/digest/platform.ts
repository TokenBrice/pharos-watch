import type {
  DigestStyleGateMode,
  DigestValidationIssue,
} from "../daily-digest/response";
import type { DigestSafetyContext } from "@shared/types/digest";
import { throwIfAborted } from "../../lib/abort";
import {
  type DigestEffort,
  type DigestLlmConfig,
} from "../../lib/constants";
import {
  recordCronFailure,
  type CronProgressReporter,
  type CronResult,
} from "../../lib/cron-logger";
import { reportCronProgress } from "../../lib/cron-progress";
import { runWithOverloadRetry } from "../../lib/d1-overload-retry";
import { recordOutcomeSafe, shouldAttemptFetch } from "../../lib/circuit-breaker";
import { findUnboundDigestSafetyClaimMarkers } from "../../lib/digest-safety-context";
import type { AnthropicRefusalCategory } from "./anthropic-stream";
import { tryParseJson } from "../../lib/json-parse";
import type { DigestCredentialDiagnostics, DigestPublicationOutcome } from "./publish";

export interface DigestLlmAttemptTelemetry {
  attemptNumber: number;
  requestKind: "original" | "corrective";
  httpAttempt: number;
  requestedModel: string;
  servedModel: string | null;
  effort: DigestEffort;
  maxTokens: number;
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  stopReason: string | null;
  refusalCategory: AnthropicRefusalCategory | null;
  latencyMs: number;
  costUsd: number | null;
  httpStatus: number | null;
}

export interface DigestEditorialStyleGateFinding {
  ruleId: string;
  field: string | null;
  excerpt: string;
  originalSeverity: "hard" | "advisory";
}

export interface DigestEditorialStyleGateTelemetry {
  mode: DigestStyleGateMode;
  firstPassWouldBlock: boolean;
  firstPassFindings: DigestEditorialStyleGateFinding[];
  firstPassFindingCount: number;
  firstPassFindingsTruncated: boolean;
  retry: {
    eligible: boolean;
    attempted: boolean;
    outcome:
      | "not-needed"
      | "shadow-observed"
      | "skipped-time-budget"
      | "skipped-token-budget"
      | "resolved"
      | "unresolved";
  };
  finalUnresolvedFindings: DigestEditorialStyleGateFinding[];
  finalUnresolvedFindingCount: number;
  finalUnresolvedFindingsTruncated: boolean;
}

export interface RequestDigestCopyResult {
  kind: "ok" | "circuit-open" | "refusal";
  digestTitle: string;
  digestText: string;
  digestExtended: string;
  digestMeta: string | null;
  usedRawTextFallback: boolean;
  qualityIssues: DigestValidationIssue[];
  hasBlockingQualityIssues: boolean;
  llmAttempts: DigestLlmAttemptTelemetry[];
  refusalCategory: AnthropicRefusalCategory | null;
  editorialStyleGate?: DigestEditorialStyleGateTelemetry;
}

interface InsertDigestRecordOptions {
  db: D1Database;
  generatedAt: number;
  digestText: string;
  digestTitle: string | null;
  inputData: unknown;
  digestExtended: string | null;
  digestMeta: string | null;
  signal?: AbortSignal;
}

interface RunDigestChannelDeliveryOptions<TCreds> {
  db: D1Database;
  circuitSource: string;
  creds: TCreds | null;
  logPrefix: string;
  channelLabel: string;
  deliver: (creds: TCreds) => Promise<string | void>;
}

export type DigestChannelDisposition =
  | "delivered"
  | "retryable"
  | "terminal-unsent"
  | "not-configured";

export function hasNonDeliveringDisposition(
  dispositions: Record<"twitter" | "telegram", DigestChannelDisposition>,
): boolean {
  return Object.values(dispositions).some(
    (disposition) => disposition === "retryable" || disposition === "terminal-unsent",
  );
}

/**
 * Worker-only scaffolding shared by the daily and weekly digest entrypoints.
 * It stays beside the Anthropic platform path because these helpers carry
 * CronResult/CronProgressReporter and worker safety-validation contracts.
 */
export type DigestEditionLabel = "daily digest" | "weekly recap";

export interface DigestQualityCopy {
  digestTitle: string;
  digestText: string;
  digestExtended: string;
  qualityIssues: DigestValidationIssue[];
  hasBlockingQualityIssues: boolean;
}

export interface DigestQualityAssessment {
  safetyCopyIssues: DigestValidationIssue[];
  qualityIssues: DigestValidationIssue[];
  hasBlockingQualityIssues: boolean;
}

export interface DigestLlmTelemetry {
  model: string;
  effort: DigestEffort;
  maxTokens: number;
  attempts: DigestLlmAttemptTelemetry[];
}

interface FinalizeDigestCronResultOptions {
  reportProgress?: CronProgressReporter;
  completionMessage: string;
  progressCountTotals: Record<string, unknown>;
  progressMetadata?: Record<string, unknown>;
  summaryBeforeQuality: string;
  summaryAfterQuality?: string;
  metadataAfterSummary?: Record<string, unknown>;
  publication: DigestPublicationOutcome;
  credentialDiagnostics: DigestCredentialDiagnostics;
  degradedReasons: readonly string[];
  qualityIssues: readonly DigestValidationIssue[];
  hasBlockingQualityIssues: boolean;
  llmConfig: DigestLlmConfig;
  digestCopy: Pick<RequestDigestCopyResult, "llmAttempts" | "editorialStyleGate">;
  onQualityMetadata?: (qualityMetadata: string) => void;
}

export async function finalizeDigestCronResult(
  options: FinalizeDigestCronResultOptions,
): Promise<CronResult> {
  const qualityMetadata = options.qualityIssues.length > 0
    ? `, quality: ${options.qualityIssues.map((issue) => `${issue.code}:${issue.severity}`).join("|")}`
    : "";
  await reportCronProgress(options.reportProgress, {
    stage: "complete",
    message: options.completionMessage,
    providerFamily: "digest",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: options.progressCountTotals,
      twitterStatus: options.publication.tweetStatus,
      telegramStatus: options.publication.telegramStatus,
      ...options.progressMetadata,
      llmAttempts: options.digestCopy.llmAttempts,
      editorialStyleGate: options.digestCopy.editorialStyleGate,
    },
  });
  options.onQualityMetadata?.(qualityMetadata);
  const channels = {
    twitter: {
      status: options.publication.tweetStatus,
      disposition: options.publication.dispositions.twitter,
      missingCredentialNames: options.credentialDiagnostics.twitterMissing ?? [],
    },
    telegram: {
      status: options.publication.telegramStatus,
      disposition: options.publication.dispositions.telegram,
      missingCredentialNames: options.credentialDiagnostics.telegramMissing ?? [],
    },
  };
  const degradedReason = options.degradedReasons[0]
    ?? (options.hasBlockingQualityIssues
      ? "blocking-quality-issues"
      : hasNonDeliveringDisposition(options.publication.dispositions)
        ? "channel-not-delivered"
        : null);
  // Editorial quality findings travel beside a delivered edition: only a
  // pipeline failure, a blocking quality gate or an undelivered channel is
  // work that did not happen.
  const quality = options.qualityIssues.map((issue) => `${issue.code}:${issue.severity}`);
  return {
    itemCount: 1,
    ...(degradedReason ? { status: "degraded" as const } : {}),
    metadata: JSON.stringify({
      ...(degradedReason ? { reason: degradedReason } : {}),
      summary: `${options.summaryBeforeQuality}${qualityMetadata}${options.summaryAfterQuality ?? ""}`,
      ...options.metadataAfterSummary,
      ...(quality.length > 0 ? { quality: { issues: quality } } : {}),
      channels,
      llm: buildDigestLlmTelemetry(options.llmConfig, options.digestCopy.llmAttempts),
      editorialStyleGate: options.digestCopy.editorialStyleGate,
      wrapperEditorialAlerts: options.publication.wrapperEditorialAlerts,
    }),
  };
}

export async function reportDigestMissingApiKey(
  reportProgress: CronProgressReporter | undefined,
  edition: DigestEditionLabel,
): Promise<CronResult> {
  await reportCronProgress(reportProgress, {
    stage: "skipped",
    message: `Skipping ${edition} because Anthropic credentials are missing`,
    providerFamily: "anthropic",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      skipped: "missing-api-key",
    },
  });
  return { metadata: "skipped: no API key" };
}

export async function reportDigestCircuitOpen(
  reportProgress: CronProgressReporter | undefined,
  edition: DigestEditionLabel,
): Promise<void> {
  await reportCronProgress(reportProgress, {
    stage: "skipped",
    message: `Skipping ${edition} because Anthropic circuit is open`,
    providerFamily: "anthropic",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      skipped: "anthropic-circuit-open",
    },
  });
}

export async function reportDigestRefusal(
  reportProgress: CronProgressReporter | undefined,
  edition: DigestEditionLabel,
  refusalCategory: AnthropicRefusalCategory | null,
  llmAttempts: DigestLlmAttemptTelemetry[],
): Promise<CronResult> {
  const metadata = {
    skipped: "anthropic-refusal" as const,
    refusalCategory,
    llmAttempts,
  };
  await reportCronProgress(reportProgress, {
    stage: "skipped",
    message: `Skipping ${edition} because Anthropic refused the request`,
    providerFamily: "anthropic",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: { ...metadata },
  });
  return {
    status: "degraded",
    itemCount: 0,
    metadata: JSON.stringify(metadata),
  };
}

export async function reportDigestLlmAttempt(
  reportProgress: CronProgressReporter | undefined,
  edition: DigestEditionLabel,
  llmAttempts: DigestLlmAttemptTelemetry[],
): Promise<void> {
  await reportCronProgress(reportProgress, {
    stage: "llm-attempt",
    message: `Recorded ${edition} Anthropic attempt telemetry`,
    providerFamily: "anthropic",
    itemsDone: llmAttempts.length,
    itemsTotal: llmAttempts.length,
    metadata: { llmAttempts },
  });
}

export function buildDigestQualityAssessment(
  safetyContext: DigestSafetyContext | undefined,
  digestCopy: DigestQualityCopy,
): DigestQualityAssessment {
  const unboundSafetyClaimMarkers = findUnboundDigestSafetyClaimMarkers(
    safetyContext,
    {
      title: digestCopy.digestTitle,
      text: digestCopy.digestText,
      extended: digestCopy.digestExtended,
    },
  );
  const safetyCopyIssues: DigestValidationIssue[] = unboundSafetyClaimMarkers.length > 0
    ? [{
        code: "unbound-safety-copy",
        severity: "hard",
        message: `Safety Score copy requires an identified publication (${unboundSafetyClaimMarkers.join(", ")})`,
      }]
    : [];
  return {
    safetyCopyIssues,
    qualityIssues: [...digestCopy.qualityIssues, ...safetyCopyIssues],
    hasBlockingQualityIssues:
      digestCopy.hasBlockingQualityIssues || safetyCopyIssues.length > 0,
  };
}

export async function reportDigestGenerationComplete(
  reportProgress: CronProgressReporter | undefined,
  edition: DigestEditionLabel,
  digestCopy: Pick<DigestQualityCopy, "digestText" | "digestExtended">,
  qualityIssueCount: number,
  hasBlockingQualityIssues: boolean,
): Promise<void> {
  await reportCronProgress(reportProgress, {
    stage: "llm-generation-complete",
    message: `Received ${edition} copy from Anthropic`,
    providerFamily: "anthropic",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        qualityIssues: qualityIssueCount,
      },
      blockingQualityIssues: hasBlockingQualityIssues,
    },
  });
}

export function buildDigestLlmTelemetry(
  config: DigestLlmConfig,
  attempts: DigestLlmAttemptTelemetry[],
): DigestLlmTelemetry {
  return {
    model: config.model,
    effort: config.effort,
    maxTokens: config.maxTokens,
    attempts,
  };
}

/**
 * Map the status grammar shared by digest channel delivery paths to the
 * disposition used by cron publication decisions. Unknown statuses fail
 * closed: a status we do not understand must never look delivered.
 */
export function classifyDigestChannelStatus(status: string): DigestChannelDisposition {
  if (/\b(?:execution_unknown|failed_permanent)\b/.test(status)) {
    return "terminal-unsent";
  }
  if (status === "ok" || status.startsWith("ok+")) return "delivered";
  if (status === "skipped: already-sent") return "delivered";

  if (
    status.startsWith("failed:")
    || status === "pending"
    || status === "skipped: circuit-open"
    || status === "skipped: in-flight"
    || status === "skipped: stale-safety-identity"
    || status === "skipped: safety-identity-unavailable"
    || status === "queued: pending"
    || status === "queued: sending"
    || status === "queued: transport-control-unavailable"
    || status === "queued: transport-operator_pause"
    || status === "queued: transport-outage_open"
    || status === "queued: transport-probe_owned_elsewhere"
    || status === "outbox-pending"
    || status === "outbox-sending"
  ) {
    return "retryable";
  }

  if (
    status === "skipped: execution-unknown"
    || status === "skipped: attempt-limit"
    || status === "skipped: quality-gate"
    || status === "skipped: editorial-style-wrapper"
  ) {
    return "terminal-unsent";
  }

  if (status === "skipped: no-creds") return "not-configured";
  if (status === "outbox-sent") return "delivered";
  // Telegram's transport helper predates the shared `skipped:` grammar and
  // still emits this legacy value when credentials are absent.
  if (status === "no-creds") return "not-configured";

  return "terminal-unsent";
}


/**
 * Flag a digest_meta payload as blocked by the quality gate. Blocked rows are
 * stored for operator inspection but excluded from every public read surface
 * and from edition numbering (see NON_BLOCKED_DIGEST_SQL_FILTER).
 */
export function markDigestMetaBlocked(digestMeta: string | null): string {
  let parsed: Record<string, unknown> = {};
  if (digestMeta) {
    const decoded = tryParseJson(digestMeta, { onFailure: () => undefined });
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      parsed = decoded as Record<string, unknown>;
    }
  }
  parsed.qualityGate = "blocked";
  return JSON.stringify(parsed);
}

export async function insertDigestRecord(options: InsertDigestRecordOptions): Promise<void> {
  throwIfAborted(options.signal);
  const inputDataJson = JSON.stringify(options.inputData);

  await runWithOverloadRetry(() =>
    options.db
      .prepare(
        `INSERT INTO daily_digest (generated_at, digest_text, digest_title, input_data, digest_extended, digest_meta)
         SELECT ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1
              FROM daily_digest
             WHERE generated_at = ?
               AND digest_text = ?
               AND digest_title IS ?
               AND input_data = ?
               AND digest_extended IS ?
               AND digest_meta IS ?
          )`,
      )
      .bind(
        options.generatedAt,
        options.digestText,
        options.digestTitle,
        inputDataJson,
        options.digestExtended,
        options.digestMeta,
        options.generatedAt,
        options.digestText,
        options.digestTitle,
        inputDataJson,
        options.digestExtended,
        options.digestMeta,
      )
      .run(),
    3,
    options.signal,
  );
  throwIfAborted(options.signal);
}

export function didDigestChannelDeliver(status: string): boolean {
  return classifyDigestChannelStatus(status) === "delivered";
}

export async function runDigestChannelDelivery<TCreds>(
  options: RunDigestChannelDeliveryOptions<TCreds>,
): Promise<string> {
  if (!options.creds) {
    return "skipped: no-creds";
  }
  const allowed = await shouldAttemptFetch(options.db, options.circuitSource);
  if (!allowed) {
    return "skipped: circuit-open";
  }

  try {
    const result = await options.deliver(options.creds);
    const status = result ?? "ok";
    // A non-throwing skip (for example already-sent, in-flight, or a safety
    // identity hold) did not make a provider request succeed. Leave the
    // breaker untouched unless the channel explicitly reports delivery.
    if (status === "ok" || status.startsWith("ok+")) {
      await recordOutcomeSafe(options.db, options.circuitSource, true);
    }
    return status;
  } catch (err) {
    await recordOutcomeSafe(options.db, options.circuitSource, false);
    recordCronFailure(options.logPrefix, err, {
      metadata: { stage: "channel-delivery", channel: options.channelLabel, fatal: false },
    });
    return `failed: ${String(err).slice(0, 100)}`;
  }
}
