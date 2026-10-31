import { toErrorMessage } from "@shared/lib/error-utils";
import { logWorkerEventArgs } from "../lib/structured-log";
import { formatIsoDate } from "@shared/lib/format";
import { bucketUnixSecondsToUtcDay } from "@shared/lib/time-buckets";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { createCronResult, createNeutralSkippedCronResult } from "../lib/cron-result";
import type { TelegramCreds } from "../telegram/delivery/telegram";
import type { TwitterCreds } from "../lib/twitter";
import { DAY_SECONDS } from "@shared/lib/time-constants";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { parseJson, parseJsonObject } from "../lib/json-parse";
import {
  buildDigestQualityAssessment,
  classifyDigestChannelStatus,
  finalizeDigestCronResult,
  hasNonDeliveringDisposition,
  reportDigestCircuitOpen,
  reportDigestGenerationComplete,
  reportDigestLlmAttempt,
  reportDigestMissingApiKey,
  reportDigestRefusal,
} from "./digest/platform";
import { requestDigestCopy, resolveDigestLlmConfig } from "./digest/llm-request";
import { reportCronProgress } from "../lib/cron-progress";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_INTERNAL_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "../lib/digest-sql-filters";
import { buildRecentDigestMeta } from "./daily-digest/runtime-helpers";
import { buildWeeklyInputData } from "./weekly-recap/input-data";
import { WEEKLY_SYSTEM_PROMPT, buildWeeklyLeadRequirements, buildWeeklyPrompt } from "./weekly-recap/prompt";
import type { DailyDigestSourceRow } from "./weekly-recap/types";
import type { DigestSafetyContext } from "@shared/types/digest";
import {
  digestSafetyContextFromPersistedInput,
  loadDigestSafetyContext,
} from "../lib/digest-safety-context";
import { resolveDigestSafetyMap } from "../lib/digest-safety-map";
import {
  buildDigestTelegramPublication,
  buildDigestTwitterPublication,
  deliverDigestEdition,
  publishDigestEdition,
  readDigestTelegramOutboxState,
  type DigestCredentialDiagnostics,
} from "./digest/publish";
import { WEEKLY_RECAP_LLM_CONFIG, type DigestLlmConfig } from "../lib/constants";
import { resolveDigestStyleGateMode } from "../lib/digest-style-gate";
import { resolveDigestLlmProfile } from "../lib/digest-llm-profile";
import { readTwitterDigestDeliveryStatus } from "../lib/twitter-digest-ledger";

const TWITTER_SENT_MARKER_PREFIX = "weekly-recap:twitter-sent:";

interface ExistingWeeklyDigestRow {
  generated_at: number;
  digest_title: string | null;
  digest_text: string;
  digest_extended: string | null;
  digest_meta: string | null;
  input_data: string | null;
}


export async function generateWeeklyRecap(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
  scheduledAtSec = Math.floor(Date.now() / 1000),
  credentialDiagnostics: DigestCredentialDiagnostics = {},
  llmConfig: DigestLlmConfig = WEEKLY_RECAP_LLM_CONFIG,
): Promise<CronResult> {
  const resolvedLlmConfig = resolveDigestLlmConfig(WEEKLY_RECAP_LLM_CONFIG, llmConfig);
  await reportCronProgress(reportProgress, {
    stage: "preflight",
    message: "Checking weekly recap prerequisites",
    providerFamily: "digest",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        configuredDeliveryChannels: Number(Boolean(twitterCreds)) + Number(Boolean(telegramCreds)),
      },
    },
  });
  if (!anthropicApiKey) {
    return reportDigestMissingApiKey(reportProgress, "weekly recap");
  }

  // Calendar identity belongs to the scheduled slot, not delayed execution.
  const scheduledDate = new Date(scheduledAtSec * 1000);
  if (scheduledDate.getUTCDay() !== 1) {
    await reportCronProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap outside Monday UTC",
      providerFamily: "digest",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "not-monday",
        utcDay: scheduledDate.getUTCDay(),
      },
    });
    return createNeutralSkippedCronResult("not-monday", {
      skipped: "not-monday",
      utcDay: scheduledDate.getUTCDay(),
    });
  }

  // Check the scheduled edition day. A non-blocked row with retryable channel
  // state remains eligible for duplicate-safe delivery recovery.
  const digestDate = formatIsoDate(scheduledAtSec);
  const editionDayStart = bucketUnixSecondsToUtcDay(scheduledAtSec);
  const editionDayEnd = editionDayStart + DAY_SECONDS;
  const existing = await db
    .prepare(
      `SELECT generated_at, digest_title, digest_text, digest_extended, digest_meta, input_data
         FROM daily_digest
        WHERE generated_at >= ?
          AND generated_at < ?
          AND json_extract(digest_meta, '$.type') = 'weekly'
          AND (${NON_INTERNAL_DIGEST_SQL_FILTER})
          AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
        ORDER BY generated_at DESC
        LIMIT 1`,
    )
    .bind(editionDayStart, editionDayEnd)
    .first<ExistingWeeklyDigestRow>();
  if (existing) {
    const markerKey = `${TWITTER_SENT_MARKER_PREFIX}${digestDate}`;
    const editionKey = `weekly:${digestDate}`;
    const twitterStatus = twitterCreds ? await readTwitterDigestDeliveryStatus(db, markerKey) : null;
    const telegramState = telegramCreds ? await readDigestTelegramOutboxState(db, editionKey) : null;
    const telegramStatus = telegramCreds ? `outbox-${telegramState ?? "execution_unknown"}` : null;
    const dispositions = {
      twitter: classifyDigestChannelStatus(twitterStatus ?? (twitterCreds ? "pending" : "skipped: no-creds")),
      telegram: classifyDigestChannelStatus(telegramStatus ?? "no-creds"),
    };
    // Production diagnostics are always arrays (empty when every credential is
    // configured), so an absent-or-empty list is the no-missing-credentials case.
    const twitterMissing = credentialDiagnostics.twitterMissing ?? [];
    const telegramMissing = credentialDiagnostics.telegramMissing ?? [];
    if (!hasNonDeliveringDisposition(dispositions)
      && twitterMissing.length === 0 && telegramMissing.length === 0) {
      await reportCronProgress(reportProgress, {
        stage: "skipped",
        message: "Skipping weekly recap because this week already exists",
        providerFamily: "digest",
        itemsDone: 0,
        itemsTotal: 1,
        metadata: {
          skipped: "weekly-recap-exists",
          existingGeneratedAt: existing.generated_at,
        },
      });
      return createNeutralSkippedCronResult("weekly-recap-exists", {
        skipped: "weekly-recap-exists",
        existingGeneratedAt: existing.generated_at,
      });
    }
    await reportCronProgress(reportProgress, {
      stage: "channel-delivery-retry",
      message: "Retrying weekly recap channel delivery",
      providerFamily: "digest",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        existingGeneratedAt: existing.generated_at,
      },
    });
    const parsedExistingInput = parseJson(existing.input_data, {
      context: "daily_digest.input_data",
      onFailure: ({ message }) =>
        logMalformedJsonPath(
          {
            scope: "cron",
            owner: "weekly-recap",
            context: "daily_digest.input_data",
            reason: "json-parse-failed",
            source: "daily_digest",
            updatedAt: existing.generated_at,
          },
          new Error(message),
        ),
    });
    const existingInput = parsedExistingInput.ok
      ? parsedExistingInput.value
      : null;
    const safetyContext = digestSafetyContextFromPersistedInput(existingInput);
    const retryNowSec = Math.floor(Date.now() / 1000);
    const safetyMap = twitterCreds && twitterStatus == null
      ? await resolveDigestSafetyMap(digestDate, retryNowSec, signal)
      : null;
    const retryDegradedReasons: string[] = [];
    const retry = await deliverDigestEdition({
      db,
      kind: "weekly",
      generatedAt: existing.generated_at,
      deliveryAt: retryNowSec,
      digestDate,
      editionNumber: null,
      copy: {
        title: existing.digest_title ?? "",
        text: existing.digest_text,
        extended: existing.digest_extended ?? existing.digest_text,
      },
      safetyContext,
      qualityGateStatus: null,
      degradedReasons: retryDegradedReasons,
      safetyMap,
      twitter: twitterStatus == null
        ? buildDigestTwitterPublication(twitterCreds, markerKey, credentialDiagnostics.twitterMissing)
        : null,
      // Existing weekly payloads are immutable; absent legacy evidence refuses
      // delivery rather than treating a missing outbox row as proof of unsent.
      telegram: null,
      signal,
      reportProgress,
    });
    const tweetStatus = twitterStatus ?? retry.tweetStatus;
    const finalTelegramState = telegramState == null ? null : await readDigestTelegramOutboxState(db, editionKey);
    const finalTelegramStatus = telegramStatus == null
      ? (credentialDiagnostics.telegramMissing != null ? "no-creds" : retry.telegramStatus)
      : `outbox-${finalTelegramState ?? "execution_unknown"}`;
    const finalDispositions = {
      twitter: twitterCreds || credentialDiagnostics.twitterMissing == null
        ? classifyDigestChannelStatus(tweetStatus) : "terminal-unsent" as const,
      telegram: telegramCreds || credentialDiagnostics.telegramMissing == null
        ? classifyDigestChannelStatus(finalTelegramStatus) : "terminal-unsent" as const,
    };
    await reportCronProgress(reportProgress, {
      stage: "complete",
      message: "Completed weekly recap channel retry",
      providerFamily: "digest",
      itemsDone: 1,
      itemsTotal: 1,
      metadata: {
        twitterStatus: tweetStatus,
        telegramStatus: finalTelegramStatus,
      },
    });
    return createCronResult({
      itemCount: 0,
      ...(retryDegradedReasons.length > 0 || hasNonDeliveringDisposition(finalDispositions)
        ? { status: "degraded" as const }
        : {}),
      metadata: {
        reason: retryDegradedReasons.join(",") || (hasNonDeliveringDisposition(finalDispositions) ? "delivery-not-completed" : "delivery-completed"),
        summary: `weekly: existing recap delivery retry, tweet: ${tweetStatus}, telegram: ${finalTelegramStatus}`,
        channels: {
          twitter: { status: tweetStatus, disposition: finalDispositions.twitter },
          telegram: { status: finalTelegramStatus, disposition: finalDispositions.telegram },
        },
        degradedReasons: retryDegradedReasons,
      },
    });
  }

  const recentWeeklyRows = await db
    .prepare(
      `SELECT digest_title, digest_text, digest_meta
       FROM daily_digest
       WHERE json_extract(digest_meta, '$.type') = 'weekly'
         AND (${NON_INTERNAL_DIGEST_SQL_FILTER})
         AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ORDER BY generated_at DESC LIMIT 4`,
    )
    .all<{ digest_title: string | null; digest_text: string; digest_meta: string | null }>();
  const recentWeeklyMeta = buildRecentDigestMeta(recentWeeklyRows.results ?? []).map((entry) => ({
    meta: entry.meta as Record<string, unknown> | null,
    title: entry.title,
    rawText: entry.rawText,
  }));

  await reportCronProgress(reportProgress, {
    stage: "input-collection",
    message: "Collecting weekly recap source digests",
    providerFamily: "pharos-d1",
    itemsDone: 0,
    itemsTotal: 15,
    metadata: {
      countTotals: {
        recentWeeklyMeta: recentWeeklyMeta.length,
      },
    },
  });
  // Two seven-day UTC edition windows, bounded by the scheduled slot.
  const todayTs = bucketUnixSecondsToUtcDay(scheduledAtSec);
  const weekBoundary = todayTs - 6 * DAY_SECONDS;
  const cutoff = weekBoundary - 7 * DAY_SECONDS;
  const dailyRows = await db
    .prepare(
      `WITH latest_daily AS (
         SELECT generated_at, digest_title, digest_text, input_data,
                ROW_NUMBER() OVER (
                  PARTITION BY strftime('%Y-%m-%d', generated_at, 'unixepoch')
                  ORDER BY generated_at DESC
                ) AS row_rank
         FROM daily_digest
         WHERE generated_at >= ? AND generated_at <= ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       )
       SELECT generated_at, digest_title, digest_text, input_data
       FROM latest_daily
       WHERE row_rank = 1
       ORDER BY generated_at ASC
       LIMIT 14`,
    )
    .bind(cutoff, scheduledAtSec)
    .all<DailyDigestSourceRow>();

  const allRows = dailyRows.results ?? [];
  const currentRows = allRows.filter((r) => r.generated_at >= weekBoundary);
  const priorRows = allRows.filter((r) => r.generated_at >= cutoff && r.generated_at < weekBoundary);
  await reportCronProgress(reportProgress, {
    stage: "input-collected",
    message: "Collected weekly recap source digests",
    providerFamily: "pharos-d1",
    itemsDone: allRows.length,
    itemsTotal: 15,
    metadata: {
      countTotals: {
        totalDailyRows: allRows.length,
        currentWeekRows: currentRows.length,
        priorWeekRows: priorRows.length,
        recentWeeklyMeta: recentWeeklyMeta.length,
      },
      cursor: {
        weekBoundary,
      },
    },
  });

  if (currentRows.length < 5) {
    await reportCronProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap because current-week coverage is incomplete",
      providerFamily: "pharos-d1",
      itemsDone: currentRows.length,
      itemsTotal: 5,
      metadata: {
        skipped: "insufficient-current-week-digests",
        countTotals: {
          currentWeekRows: currentRows.length,
          requiredCurrentWeekRows: 5,
        },
      },
    });
    return createNeutralSkippedCronResult("insufficient-current-week-digests", {
      currentWeekRows: currentRows.length,
      requiredCurrentWeekRows: 5,
    });
  }

  let safetyContext: DigestSafetyContext;
  try {
    safetyContext = await loadDigestSafetyContext(db, signal);
  } catch (error) {
    logWorkerEventArgs("handler", "error", JSON.stringify({
      scope: "weekly-recap",
      message: "Failed to resolve active Safety Score source",
      error: toErrorMessage(error),
    }));
    safetyContext = {
      status: "unavailable",
      expectedModel: "v9",
      identity: null,
      publishedAt: null,
      reason: "source-load-failed",
    };
  }
  const weeklyData = buildWeeklyInputData(currentRows, priorRows, safetyContext, {
    current: { start: todayTs - 7 * DAY_SECONDS, end: todayTs },
    prior: { start: todayTs - 14 * DAY_SECONDS, end: todayTs - 7 * DAY_SECONDS },
  }, { start: weekBoundary, end: scheduledAtSec });
  if (!weeklyData) {
    await reportCronProgress(reportProgress, {
      stage: "input-unavailable",
      message: "Failed to build weekly recap input data",
      providerFamily: "pharos-d1",
      itemsDone: currentRows.length,
      itemsTotal: currentRows.length,
    });
    return createNeutralSkippedCronResult("weekly-input-unavailable");
  }

  const userPrompt = buildWeeklyPrompt(weeklyData, recentWeeklyMeta);
  const styleGateMode = await resolveDigestStyleGateMode(db, "weekly", signal);
  const llmProfile = await resolveDigestLlmProfile(db, "weekly", signal);
  await reportCronProgress(reportProgress, {
    stage: "llm-generation",
    message: "Requesting weekly recap copy from Anthropic",
    providerFamily: "anthropic",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        promptChars: userPrompt.length,
        currentWeekRows: currentRows.length,
        priorWeekRows: priorRows.length,
        weeklyRiskSignals: weeklyData.weeklySignals.riskLeaderboard.length,
        maxTokens: resolvedLlmConfig.maxTokens,
      },
    },
  });

  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: WEEKLY_SYSTEM_PROMPT,
    userPrompt,
    llmConfig: resolvedLlmConfig,
    signal,
    logPrefix: "weekly-recap",
    llmProfile,
    reportAttempt: (llmAttempts) => reportDigestLlmAttempt(reportProgress, "weekly recap", llmAttempts),
    parseOptions: {
      metaFactory: ({ parsedMeta, usedRawTextFallback: degraded }) => ({
        ...(parsedMeta ?? {}),
        type: "weekly",
        periodType: weeklyData.periodType,
        weekStart: weeklyData.weekStartDate,
        weekEnd: weeklyData.weekEndDate,
        ...(degraded ? { degraded: "raw-text-fallback" } : {}),
      }),
    },
    validationProfile: {
      kind: "weekly",
      styleGateMode,
      recentMeta: recentWeeklyMeta,
      leadRequirements: buildWeeklyLeadRequirements(weeklyData),
      forbidSafetyClaims: safetyContext.status !== "available",
    },
  });
  if (digestCopy.kind === "circuit-open") {
    return reportDigestCircuitOpen(reportProgress, "weekly recap");
  }
  if (digestCopy.kind === "refusal") {
    return reportDigestRefusal(
      reportProgress,
      "weekly recap",
      digestCopy.refusalCategory,
      digestCopy.llmAttempts,
    );
  }
  const {
    qualityIssues,
    safetyCopyIssues,
    hasBlockingQualityIssues,
  } = buildDigestQualityAssessment(safetyContext, digestCopy);
  const degradedReasons: string[] = [];
  if (digestCopy.usedRawTextFallback) degradedReasons.push("raw-text-fallback");
  if (safetyContext.status === "unavailable") degradedReasons.push("safety-context-unavailable");
  if (safetyCopyIssues.length > 0) degradedReasons.push("unbound-safety-copy");
  await reportDigestGenerationComplete(
    reportProgress,
    "weekly recap",
    digestCopy,
    qualityIssues.length,
    hasBlockingQualityIssues,
  );

  const publicationNowSec = Math.floor(Date.now() / 1000);
  const generatedAt = scheduledAtSec;
  const initialDigestMeta = JSON.stringify({
    type: "weekly",
    periodType: weeklyData.periodType,
    weekStart: weeklyData.weekStartDate,
    weekEnd: weeklyData.weekEndDate,
    safetyContext: weeklyData.safetyContext,
    ...parseJsonObject(digestCopy.digestMeta, "weekly-recap:digest_meta"),
  });

  const qualityGateStatus = hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  const safetyMap = twitterCreds || telegramCreds
    ? await resolveDigestSafetyMap(digestDate, publicationNowSec, signal)
    : null;
  const publication = await publishDigestEdition({
    db,
    kind: "weekly",
    generatedAt,
    deliveryAt: publicationNowSec,
    digestDate,
    editionNumber: null,
    copy: {
      title: digestCopy.digestTitle,
      text: digestCopy.digestText,
      extended: digestCopy.digestExtended,
      meta: initialDigestMeta,
    },
    inputData: weeklyData,
    safetyContext,
    qualityGateStatus,
    degradedReasons,
    safetyMap,
    twitter: buildDigestTwitterPublication(
      twitterCreds,
      `${TWITTER_SENT_MARKER_PREFIX}${digestDate}`,
      credentialDiagnostics.twitterMissing,
    ),
    telegram: buildDigestTelegramPublication(
      telegramCreds,
      credentialDiagnostics.telegramMissing,
      {
        editionKey: `weekly:${digestDate}`,
        title: `Weekly Recap: ${digestCopy.digestTitle || `Week of ${weeklyData.weekStartDate}`}`,
        routeDate: `${digestDate}-weekly`,
        alreadySentStatus: "ok+already-sent",
      },
    ),
    signal,
    reportProgress,
  });

  return finalizeDigestCronResult({
    reportProgress,
    completionMessage: "Completed weekly recap generation",
    progressCountTotals: {
      textChars: digestCopy.digestText.length,
      extendedChars: digestCopy.digestExtended.length,
      qualityIssues: qualityIssues.length,
    },
    progressMetadata: { usedRawTextFallback: digestCopy.usedRawTextFallback },
    summaryBeforeQuality: `weekly: ${digestCopy.digestText.length} chars, tweet: ${publication.tweetStatus}, telegram: ${publication.telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}`,
    metadataAfterSummary: { digestDate, scheduledAtSec },
    publication,
    credentialDiagnostics,
    degradedReasons,
    qualityIssues,
    hasBlockingQualityIssues,
    llmConfig: resolvedLlmConfig,
    digestCopy,
  });
}
