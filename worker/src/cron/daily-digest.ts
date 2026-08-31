import { logWorkerEventArgs } from "../lib/structured-log";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import type { TwitterCreds } from "../lib/twitter";
import type { TelegramCreds } from "../lib/telegram";
import type { TelegramRecapRolloutPolicy } from "@shared/lib/telegram-recap-rollout";
import { SECONDS } from "../lib/time-constants";
import { formatIsoDate } from "@shared/lib/format";
import { setCache } from "../lib/db-cache";
import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY } from "../lib/depeg-lifecycle";
import { prepareTelegramDigestAppendices } from "../lib/telegram-digest-appendices";
import { buildDailyDigestInput, buildDigestSafetyMapCapture } from "./daily-digest/input";
import { formatStandingConditionsLine } from "./daily-digest/cause-context";
import { buildUserPrompt, SYSTEM_PROMPT } from "./daily-digest/prompt";
import { reportCronProgress } from "../lib/cron-progress";
import { formatQualityMetadata } from "./digest/quality-metadata";
import { logDailyDigestLlmCall } from "./daily-digest/runtime-helpers";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_INTERNAL_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "../lib/digest-sql-filters";
import { buildCriticalDailyLeadRequirements } from "./daily-digest/critical-lead-requirements";
import { attachDigestEditorialAudit } from "./daily-digest/digest-intelligence";
import { logWorkerEvent } from "../lib/structured-log";
import {
  buildDigestSafetyMapCaptions,
  resolveDigestSafetyMap,
  type DigestSafetyMapResolution,
} from "../lib/digest-safety-map";
import { safeJsonParse } from "../lib/api-cache-read";
import type { DigestInputData } from "@shared/types/digest";
import {
  buildDigestTelegramPublication,
  buildDigestTwitterPublication,
  deliverDigestEdition,
  publishDigestEdition,
  type DigestCredentialDiagnostics,
} from "./digest/publish";
import {
  buildDigestLlmTelemetry,
  buildDigestQualityAssessment,
  classifyDigestChannelStatus,
  reportDigestCircuitOpen,
  reportDigestGenerationComplete,
  reportDigestLlmAttempt,
  reportDigestMissingApiKey,
  reportDigestRefusal,
  requestDigestCopy,
  resolveDigestLlmConfig,
} from "./digest/platform";
import { DAILY_DIGEST_LLM_CONFIG, type DigestLlmConfig } from "../lib/constants";

export { classifyRegime } from "./daily-digest/prompt";

const TWITTER_SENT_MARKER_PREFIX = "daily-digest:twitter-sent:";

function getTwitterSentMarkerKey(date: string): string {
  return `${TWITTER_SENT_MARKER_PREFIX}${date}`;
}

function hasNonDeliveringDisposition(
  dispositions: Record<"twitter" | "telegram", "delivered" | "retryable" | "terminal-unsent" | "not-configured">,
): boolean {
  return Object.values(dispositions).some(
    (disposition) => disposition === "retryable" || disposition === "terminal-unsent",
  );
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
  credentialDiagnostics: DigestCredentialDiagnostics = {},
  llmConfig: DigestLlmConfig = DAILY_DIGEST_LLM_CONFIG,
  recapRollout: TelegramRecapRolloutPolicy | null = null,
): Promise<CronResult> {
  const resolvedLlmConfig = resolveDigestLlmConfig(DAILY_DIGEST_LLM_CONFIG, llmConfig);
  await reportCronProgress(reportProgress, {
    stage: "preflight",
    message: "Checking daily digest generation prerequisites",
    providerFamily: "digest",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        forceRun: force ? 1 : 0,
        configuredDeliveryChannels: Number(Boolean(twitterCreds)) + Number(Boolean(telegramCreds)),
      },
    },
  });
  if (!anthropicApiKey) {
    logWorkerEventArgs("handler", "info", "[daily-digest] No API key configured, skipping");
    return reportDigestMissingApiKey(reportProgress, "daily digest");
  }

  // Check if latest digest is <1h old and valid (not a broken code-block response)
  const latest = await db
    .prepare(
      "SELECT generated_at, digest_text FROM daily_digest ORDER BY generated_at DESC LIMIT 1",
    )
    .first<{ generated_at: number; digest_text: string }>();

  if (latest) {
    const ageSec = Math.floor(Date.now() / 1000) - latest.generated_at;
    const isBroken = latest.digest_text.trimStart().startsWith("```");
    if (ageSec < SECONDS.ONE_HOUR && !isBroken && !force) {
      logWorkerEventArgs("handler", "info",
        `[daily-digest] Latest digest is ${Math.round(ageSec / 60)}min old, skipping`,
      );
      await reportCronProgress(reportProgress, {
        stage: "skipped",
        message: "Skipping daily digest because a recent digest exists",
        providerFamily: "digest",
        itemsDone: 0,
        itemsTotal: 1,
        metadata: {
          skipped: "recent-digest",
          ageSec,
        },
      });
      return { metadata: "skipped: recent digest exists" };
    }
    if (isBroken) {
      logWorkerEventArgs("handler", "info", "[daily-digest] Latest digest is malformed (code-block response), regenerating");
    }
  }

  await reportCronProgress(reportProgress, {
    stage: "input-collection",
    message: "Collecting daily digest market context",
    providerFamily: "pharos-d1",
    itemsDone: 0,
    itemsTotal: 1,
  });
  const digestInput = await buildDailyDigestInput(db);
  const { inputData, degradedReasons, recentMeta, previousInputData, recentLeadSignalIds, lifecycleFlags, recentTitles, llmSignals, stablecoinsCacheReason } = digestInput;
  if (stablecoinsCacheReason) {
    await reportCronProgress(reportProgress, {
      stage: "input-unavailable",
      message: "Daily digest stablecoins cache is unavailable",
      providerFamily: "pharos-d1",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        stablecoinsCacheReason,
      },
    });
    return {
      status: "degraded",
      itemCount: 0,
      metadata: JSON.stringify({
        reason: "stablecoins-cache-unavailable",
        stablecoinsCacheReason,
        skipped: true,
      }),
    };
  }
  const now = Math.floor(Date.now() / 1000);
  const digestDate = formatIsoDate(now);
  const safetyMap = await resolveDigestSafetyMap(digestDate, now, signal);
  const safetyMapCapture = buildDigestSafetyMapCapture(inputData, safetyMap);
  if (safetyMapCapture) inputData.safetyMap = safetyMapCapture;
  const leadRequirements = buildCriticalDailyLeadRequirements(inputData, {
    previousInputData,
    recentLeadSignalIds,
  });
  const userPromptContent = buildUserPrompt(inputData, recentMeta, { leadRequirements, recentLeadSignalIds });
  await reportCronProgress(reportProgress, {
    stage: "input-collected",
    message: "Collected daily digest context",
    providerFamily: "pharos-d1",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        recentDigestMeta: recentMeta.length,
        activeDepegs: llmSignals.activeDepegCount,
        topDepegs: llmSignals.topDepegs.length,
        resolvedDepegs: llmSignals.resolvedDepegs.length,
        yieldAnomalies: llmSignals.yieldAnomalies.length,
        liquidityShifts: llmSignals.liquidityShifts.length,
        degradedReasons: degradedReasons.length,
      },
      leadRequirementCount: leadRequirements?.length ?? 0,
    },
  });
  logDailyDigestLlmCall({
    activeDepegCount: llmSignals.activeDepegCount,
    topDepegs: llmSignals.topDepegs,
    resolvedDepegs: llmSignals.resolvedDepegs,
    yieldAnomalies: llmSignals.yieldAnomalies,
    liquidityShifts: llmSignals.liquidityShifts,
    recentMeta,
    degradedReasons,
  });
  await reportCronProgress(reportProgress, {
    stage: "llm-generation",
    message: "Requesting daily digest copy from Anthropic",
    providerFamily: "anthropic",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        promptChars: userPromptContent.length,
        maxTokens: resolvedLlmConfig.maxTokens,
      },
    },
  });
  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPromptContent,
    llmConfig: resolvedLlmConfig,
    signal,
    logPrefix: "daily-digest",
    reportAttempt: (llmAttempts) => reportDigestLlmAttempt(reportProgress, "daily digest", llmAttempts),
    validationProfile: {
      kind: "daily",
      recentMeta: recentMeta.map((entry) => ({
        meta: entry.meta as Record<string, unknown> | null,
        title: entry.title,
        rawText: entry.rawText,
        extended: entry.extended,
      })),
      leadRequirements,
      depegFacts: llmSignals.topDepegs,
      prevDepegFacts: previousInputData?.topDepegs ?? [],
      recentTitles,
      forbidSafetyClaims: inputData.safetyContext?.status !== "available",
      suppressedCandidateIds: (inputData.editorialCandidates ?? [])
        .filter((candidate) => candidate.suppressReason)
        .map((candidate) => candidate.id),
    },
  });
  if (digestCopy.kind === "circuit-open") {
    await reportDigestCircuitOpen(reportProgress, "daily digest");
    return { status: "degraded", itemCount: 0, metadata: "skipped: anthropic circuit open" };
  }
  if (digestCopy.kind === "refusal") {
    return reportDigestRefusal(
      reportProgress,
      "daily digest",
      digestCopy.refusalCategory,
      digestCopy.llmAttempts,
    );
  }
  const {
    qualityIssues,
    safetyCopyIssues,
    hasBlockingQualityIssues,
  } = buildDigestQualityAssessment(inputData.safetyContext, digestCopy);
  if (safetyCopyIssues.length > 0) {
    degradedReasons.push("unbound-safety-copy");
  }
  await reportDigestGenerationComplete(
    reportProgress,
    "daily digest",
    digestCopy,
    qualityIssues.length,
    hasBlockingQualityIssues,
  );

  const storedInputData = attachDigestEditorialAudit({
    inputData,
    digestMeta: digestCopy.digestMeta,
    qualityIssues,
    leadRequirements,
  });
  const safetyMapCaptions = safetyMap?.kind === "available" && inputData.safetyContext?.status === "available"
    ? buildDigestSafetyMapCaptions(
        safetyMap.manifest.mapSummary,
        safetyMap.freshness,
        safetyMap.ageDays,
      )
    : null;
  const qualityGateStatus = hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  let telegramAppendices: Awaited<ReturnType<typeof prepareTelegramDigestAppendices>> | null = null;
  if (!qualityGateStatus && telegramCreds) {
    try {
      telegramAppendices = await prepareTelegramDigestAppendices(db);
    } catch (error) {
      degradedReasons.push("telegram-appendix-state");
      logWorkerEventArgs("handler", "error", "[daily-digest] Failed to prepare Telegram digest appendices:", error);
    }
  }
  const standingLine = formatStandingConditionsLine(inputData.standingConditions);
  const appendixSuffix = telegramAppendices?.metadata.hasAppendix
    ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
    : "";
  const delivery = await publishDigestEdition({
    db,
    kind: "daily",
    generatedAt: now,
    digestDate,
    editionNumber: null,
    copy: {
      title: digestCopy.digestTitle,
      text: digestCopy.digestText,
      extended: digestCopy.digestExtended,
      meta: digestCopy.digestMeta,
    },
    inputData: storedInputData,
    safetyContext: inputData.safetyContext ?? null,
    qualityGateStatus,
    degradedReasons,
    safetyMap,
    twitter: buildDigestTwitterPublication(
      twitterCreds,
      getTwitterSentMarkerKey(digestDate),
      credentialDiagnostics.twitterMissing,
    ),
    telegram: buildDigestTelegramPublication(
      telegramCreds,
      credentialDiagnostics.telegramMissing,
      {
        editionKey: `daily:${digestDate}`,
        recapRollout,
        appendixHtml: telegramAppendices?.appendixHtml ?? null,
        extraSections: [
          ...(standingLine ? [{ kind: "text" as const, content: standingLine }] : []),
          ...(safetyMapCaptions?.telegramAppendixHtml
            ? [{ kind: "html" as const, content: safetyMapCaptions.telegramAppendixHtml }]
            : []),
        ],
        successActions: telegramAppendices?.successActions ?? [],
        successStatus: `ok${appendixSuffix}`,
        alreadySentStatus: "skipped: already-sent",
      },
    ),
    signal,
    reportProgress,
  });
  const editionNumber = delivery.editionNumber;
  const tweetStatus = delivery.tweetStatus;
  const telegramStatus = delivery.telegramStatus;
  // Persist owner-review lifecycle flags (stalled collapses / chronic shallow
  // pegs needing a manual freeze-or-close ruling). Best-effort: a cache write
  // failure must not degrade an otherwise successful digest run.
  try {
    await setCache(
      db,
      DEPEG_LIFECYCLE_FLAGS_CACHE_KEY,
      JSON.stringify({ updatedAt: now, flags: lifecycleFlags }),
      signal,
    );
  } catch (err) {
    logWorkerEvent({
      scope: "lib",
      level: "error",
      event: "depeg_lifecycle_flags_persist_failed",
      job: "daily-digest",
      message: "Failed to persist depeg lifecycle flags",
      error: err,
    });
  }
  const qualityMetadata = formatQualityMetadata(qualityIssues);
  await reportCronProgress(reportProgress, {
    stage: "complete",
    message: "Completed daily digest generation",
    providerFamily: "digest",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        editionNumber,
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        degradedReasons: degradedReasons.length,
        qualityIssues: qualityIssues.length,
        lifecycleFlags: lifecycleFlags.length,
      },
      twitterStatus: tweetStatus,
      telegramStatus,
      llmAttempts: digestCopy.llmAttempts,
    },
  });
  logWorkerEventArgs("handler", "info", `[daily-digest] Generated and stored digest: "${digestCopy.digestTitle}" (${digestCopy.digestText.length} chars + ${digestCopy.digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}${qualityMetadata}`);
  const lifecycleMetadata = lifecycleFlags.length > 0
    ? `, lifecycle-review: ${lifecycleFlags.map((flag) => `${flag.symbol}:${flag.kind}`).join("|")}`
    : "";
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 || hasBlockingQualityIssues || hasNonDeliveringDisposition(delivery.dispositions)
      ? { status: "degraded" as const }
      : {}),
    metadata: JSON.stringify({
      summary: `${digestCopy.digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}${qualityMetadata}${lifecycleMetadata}`,
      channels: {
        twitter: {
          status: tweetStatus,
          disposition: delivery.dispositions.twitter,
          missingCredentialNames: credentialDiagnostics.twitterMissing ?? [],
        },
        telegram: {
          status: telegramStatus,
          disposition: delivery.dispositions.telegram,
          missingCredentialNames: credentialDiagnostics.telegramMissing ?? [],
        },
      },
      llm: buildDigestLlmTelemetry(resolvedLlmConfig, digestCopy.llmAttempts),
    }),
  };
}

export type ResumeDailyDigestDeliveryOutcome =
  | { kind: "resumed"; tweetStatus: string; telegramStatus: string; deliveryComplete: boolean }
  | { kind: "no-publishable-digest" };

/**
 * Delivery-only recovery for a day whose digest row exists but whose social
 * delivery is unresolved (for example a Twitter media-upload abort).
 * Regenerating through `generateDailyDigest` would mint a
 * duplicate edition; this path re-runs delivery from the stored copy instead.
 * Twitter stays duplicate-safe through the send-marker ledger, and a Telegram
 * edition already in the outbox is left to the drain slot.
 */
export async function resumeDailyDigestDelivery(
  db: D1Database,
  twitterCreds: TwitterCreds | null,
  telegramCreds: TelegramCreds | null,
  safetyMap: DigestSafetyMapResolution | null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
  credentialDiagnostics: DigestCredentialDiagnostics = {},
  recapRollout: TelegramRecapRolloutPolicy | null = null,
): Promise<ResumeDailyDigestDeliveryOutcome> {
  const nowSec = Math.floor(Date.now() / 1000);
  const digestDate = formatIsoDate(nowSec);
  const dayStartSec = Math.floor(Date.parse(`${digestDate}T00:00:00Z`) / 1000);
  // SAFETY: the digest SQL filters are hardcoded fragments, not user input.
  const row = await db
    .prepare(
      `SELECT generated_at, digest_text, digest_title, digest_extended, digest_meta, input_data FROM daily_digest
       WHERE generated_at >= ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_INTERNAL_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ORDER BY generated_at DESC LIMIT 1`,
    )
    .bind(dayStartSec)
    .first<{ generated_at: number; digest_text: string; digest_title: string | null; digest_extended: string | null; digest_meta: string | null; input_data: string | null }>();
  throwIfAborted(signal);
  if (!row) return { kind: "no-publishable-digest" };
  const countResult = await db
    .prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${NON_WEEKLY_DIGEST_SQL_FILTER}`)
    .all<{ cnt: number }>();
  throwIfAborted(signal);
  const editionNumber = countResult.results?.[0]?.cnt ?? null;
  // Self-produced round trip: input_data was serialized from DigestInputData
  // by insertDigestRecord in this module; delivery tolerates absent fields.
  const storedInput = row.input_data
    ? safeJsonParse<Partial<DigestInputData> | null>(row.input_data, null, "daily-digest:resume:input_data")
    : null;
  const outboxRow = telegramCreds
    ? await db
        .prepare("SELECT state FROM telegram_digest_outbox WHERE edition_key = ?")
        .bind(`daily:${digestDate}`)
        .first<{ state: string }>()
    : null;
  const alreadyEnqueued = outboxRow != null;
  if (outboxRow && (outboxRow.state === "execution_unknown" || outboxRow.state === "failed_permanent")) {
    // The drain deliberately never retries these states (a blind resend could
    // double-post), so the retry loop cannot make progress either. Escalate
    // loudly for manual outbox reconciliation instead of retrying a send that
    // may already have reached the audience.
    logWorkerEvent({
      scope: "handler",
      level: "error",
      event: "daily_digest_telegram_edition_unrecoverable",
      job: "daily-digest",
      message: "Today's Telegram digest edition is in a terminal non-sent outbox state; manual reconciliation required",
      metadata: { date: digestDate, outboxState: outboxRow.state },
    });
  }
  throwIfAborted(signal);
  const degradedReasons: string[] = [];
  let telegramAppendices: Awaited<ReturnType<typeof prepareTelegramDigestAppendices>> | null = null;
  if (!alreadyEnqueued && telegramCreds) {
    try {
      telegramAppendices = await prepareTelegramDigestAppendices(db);
    } catch (error) {
      degradedReasons.push("telegram-appendix-state");
      logWorkerEventArgs("handler", "error", "[daily-digest] Failed to prepare Telegram digest appendices:", error);
    }
  }
  const mapCaptions = safetyMap?.kind === "available" && storedInput?.safetyContext?.status === "available"
    ? buildDigestSafetyMapCaptions(
        safetyMap.manifest.mapSummary,
        safetyMap.freshness,
        safetyMap.ageDays,
      )
    : null;
  const standingLine = formatStandingConditionsLine(storedInput?.standingConditions);
  const appendixSuffix = telegramAppendices?.metadata.hasAppendix
    ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
    : "";
  const outcome = await deliverDigestEdition({
    db,
    kind: "daily",
    generatedAt: row.generated_at,
    deliveryAt: nowSec,
    digestDate,
    editionNumber,
    copy: {
      title: row.digest_title ?? "",
      text: row.digest_text,
      extended: row.digest_extended ?? "",
      // Carried so a resumed delivery picks the same subject-aware cashtag the
      // original send would have: without it, resume falls back to first-match.
      meta: row.digest_meta,
    },
    safetyContext: storedInput?.safetyContext ?? null,
    qualityGateStatus: null,
    degradedReasons,
    safetyMap,
    twitter: twitterCreds || credentialDiagnostics.twitterMissing != null
      ? {
          creds: twitterCreds,
          markerKey: getTwitterSentMarkerKey(digestDate),
          required: credentialDiagnostics.twitterMissing != null,
          missingCredentialNames: credentialDiagnostics.twitterMissing,
        }
      : null,
    // An already-enqueued Telegram edition is immutable and owned by the
    // outbox drain; re-enqueueing would diff a rebuilt payload against the
    // stored one, so the resume path leaves that channel alone.
    telegram: alreadyEnqueued
      ? null
      : telegramCreds || credentialDiagnostics.telegramMissing != null
        ? {
            creds: telegramCreds,
            editionKey: `daily:${digestDate}`,
            recapRollout,
            appendixHtml: telegramAppendices?.appendixHtml ?? null,
            extraSections: [
              ...(standingLine ? [{ kind: "text" as const, content: standingLine }] : []),
              ...(mapCaptions?.telegramAppendixHtml
                ? [{ kind: "html" as const, content: mapCaptions.telegramAppendixHtml }]
                : []),
            ],
            successActions: telegramAppendices?.successActions ?? [],
            required: credentialDiagnostics.telegramMissing != null,
            missingCredentialNames: credentialDiagnostics.telegramMissing,
            successStatus: `ok${appendixSuffix}`,
          }
        : null,
    signal,
    reportProgress,
  });
  const telegramStatus = outboxRow ? `outbox-${outboxRow.state}` : outcome.telegramStatus;
  const dispositions = {
    ...outcome.dispositions,
    telegram: outboxRow
      ? classifyDigestChannelStatus(telegramStatus)
      : outcome.dispositions.telegram,
  };
  const deliveryComplete = !hasNonDeliveringDisposition(dispositions);
  logWorkerEvent({
    scope: "handler",
    level: deliveryComplete ? "info" : "warn",
    event: "daily_digest_delivery_resumed",
    job: "daily-digest",
    message: "Resumed daily digest delivery from the stored edition",
    metadata: {
      date: digestDate,
      tweetStatus: outcome.tweetStatus,
      telegramStatus,
      deliveryComplete,
      degradedReasons,
    },
  });
  return {
    kind: "resumed",
    tweetStatus: outcome.tweetStatus,
    telegramStatus,
    deliveryComplete,
  };
}
