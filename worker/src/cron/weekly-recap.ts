import { formatIsoDate } from "@shared/lib/format";
import type { CronProgressReporter, CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { createNeutralSkippedCronResult } from "../lib/cron-result";
import type { TelegramCreds } from "../lib/telegram";
import {
  deliverTelegramDigestEdition,
  enqueueTelegramDigestEdition,
} from "../lib/telegram-digest-outbox";
import { SECONDS } from "../lib/time-constants";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { logMalformedJsonPath } from "../lib/json-decode-observability";
import { parseJson } from "../lib/json-parse";
import {
  didDigestChannelDeliver,
  insertDigestRecord,
  markDigestMetaBlocked,
  requestDigestCopy,
  runDigestChannelDelivery,
} from "./digest/platform";
import { reportDigestProgress } from "./digest/progress";
import { formatQualityMetadata } from "./digest/quality-metadata";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "./daily-digest/shared";
import { buildRecentDigestMeta } from "./daily-digest/runtime-helpers";
import { getMetaString } from "./daily-digest/digest-intelligence-utils";
import type { DigestValidationIssue } from "./daily-digest/response";
import { buildWeeklyInputData } from "./weekly-recap/input-data";
import { WEEKLY_SYSTEM_PROMPT, buildWeeklyLeadRequirements, buildWeeklyPrompt } from "./weekly-recap/prompt";
import type { DailyDigestSourceRow } from "./weekly-recap/types";
import type { DigestSafetyContext } from "@shared/types/digest";
import {
  digestSafetyContextFromPersistedInput,
  findUnboundDigestSafetyClaimMarkers,
  loadDigestSafetyContext,
} from "../lib/digest-safety-context";

interface ExistingWeeklyDigestRow {
  generated_at: number;
  digest_title: string | null;
  digest_text: string;
  digest_extended: string | null;
  digest_meta: string | null;
  input_data: string | null;
}

interface WeeklyDigestMeta {
  telegramDelivered?: boolean;
  telegramDeliveryStatus?: string;
  telegramDeliveryUpdatedAt?: number;
  telegramDeliveredAt?: number;
  [key: string]: unknown;
}

function parseWeeklyDigestMeta(rawMeta: string | null, updatedAt: number | null): WeeklyDigestMeta {
  if (!rawMeta) return {};
  const parsed = parseJson(rawMeta, {
    context: "daily_digest.digest_meta",
    onFailure: ({ message }) =>
      logMalformedJsonPath(
        {
          scope: "cron",
          owner: "weekly-recap",
          context: "daily_digest.digest_meta",
          reason: "json-parse-failed",
          source: "daily_digest",
          ...(updatedAt != null ? { updatedAt } : {}),
        },
        new Error(message),
      ),
  });
  if (
    parsed.ok &&
    parsed.value &&
    typeof parsed.value === "object" &&
    !Array.isArray(parsed.value)
  ) {
    return { ...(parsed.value as WeeklyDigestMeta) };
  }
  return {};
}

function encodeWeeklyDigestMeta(
  rawMeta: string | null,
  params: {
    generatedAt: number;
    nowSec: number;
    telegramDelivered: boolean;
    telegramDeliveryStatus: string;
    weeklyDefaults?: WeeklyDigestMeta;
  },
): string {
  const meta = parseWeeklyDigestMeta(rawMeta, params.generatedAt);
  if (!params.telegramDelivered) {
    delete meta.telegramDeliveredAt;
  }
  return JSON.stringify({
    ...(params.weeklyDefaults ?? {}),
    ...meta,
    telegramDelivered: params.telegramDelivered,
    telegramDeliveryStatus: params.telegramDeliveryStatus,
    telegramDeliveryUpdatedAt: params.nowSec,
    ...(params.telegramDelivered ? { telegramDeliveredAt: params.nowSec } : {}),
  });
}

function shouldRetryExistingWeeklyTelegram(meta: WeeklyDigestMeta): boolean {
  if (meta.telegramDelivered !== false) return false;
  const status = meta.telegramDeliveryStatus ?? "";
  if (status === "skipped: quality-gate") return false;
  return !/\b(?:execution_unknown|failed_permanent)\b/.test(status);
}

async function updateWeeklyTelegramDeliveryMeta(
  db: D1Database,
  row: { generated_at: number; digest_meta: string | null },
  params: { nowSec: number; telegramStatus: string },
): Promise<void> {
  const digestMeta = encodeWeeklyDigestMeta(row.digest_meta, {
    generatedAt: row.generated_at,
    nowSec: params.nowSec,
    telegramDelivered: didDigestChannelDeliver(params.telegramStatus),
    telegramDeliveryStatus: params.telegramStatus,
  });
  await db
    .prepare(
      `UPDATE daily_digest
          SET digest_meta = ?
        WHERE generated_at = ?
          AND json_extract(digest_meta, '$.type') = 'weekly'`,
    )
    .bind(digestMeta, row.generated_at)
    .run();
}

async function deliverWeeklyDigestToTelegram(params: {
  db: D1Database;
  telegramCreds: TelegramCreds | null;
  digestTitle: string | null;
  digestExtended: string | null;
  digestText: string;
  generatedAt: number;
  weekStartLabel: string;
  safetyContext: DigestSafetyContext;
  signal?: AbortSignal;
}): Promise<string> {
  const date = formatIsoDate(params.generatedAt);
  const editionKey = `weekly:${date}`;
  const weekLabel = `Week of ${params.weekStartLabel}`;
  const tgTitle = `Weekly Recap: ${params.digestTitle || weekLabel}`;
  if (params.telegramCreds) {
    const enqueueResult = await enqueueTelegramDigestEdition(params.db, {
      editionKey,
      digestKind: "weekly",
      digestGeneratedAt: params.generatedAt,
      targetChatId: params.telegramCreds.chatId,
      title: tgTitle,
      extended: params.digestExtended ?? params.digestText,
      date: `${date}-weekly`,
      safetyContext: params.safetyContext,
    }, params.signal);
    if (!enqueueResult.payloadMatched) {
      throw new Error(`Immutable Telegram digest edition differs (${editionKey})`);
    }
  }
  return runDigestChannelDelivery({
    db: params.db,
    circuitSource: CIRCUIT_SOURCE.TELEGRAM_API,
    creds: params.telegramCreds,
    logPrefix: "weekly-recap",
    channelLabel: "Telegram",
    deliver: async (creds) => {
      const delivery = await deliverTelegramDigestEdition(params.db, creds, editionKey, params.signal);
      if (delivery.outcome === "sent") return "ok";
      if (delivery.outcome === "skipped" && delivery.state === "sent") {
        return "ok+already-sent";
      }
      if (delivery.outcome === "skipped") return `queued: ${delivery.state}`;
      throw new Error(
        `Telegram digest ${delivery.outcome}: ${delivery.errorClass ?? "unknown"}`,
      );
    },
  });
}

export async function generateWeeklyRecap(
  db: D1Database,
  anthropicApiKey: string | null,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
  await reportDigestProgress(reportProgress, {
    stage: "preflight",
    message: "Checking weekly recap prerequisites",
    providerFamily: "digest",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        configuredDeliveryChannels: Number(Boolean(telegramCreds)),
      },
    },
  });
  if (!anthropicApiKey) {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap because Anthropic credentials are missing",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "missing-api-key",
      },
    });
    return { metadata: "skipped: no API key" };
  }

  // Check if today is Monday (UTC)
  const now = new Date();
  if (now.getUTCDay() !== 1) {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap outside Monday UTC",
      providerFamily: "digest",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "not-monday",
        utcDay: now.getUTCDay(),
      },
    });
    return createNeutralSkippedCronResult("not-monday", {
      skipped: "not-monday",
      utcDay: now.getUTCDay(),
    });
  }

  // Check if weekly recap already exists for this week. Rows that were
  // generated but not delivered to Telegram stay eligible for a delivery retry.
  const weekStart = Math.floor(Date.now() / 1000) - 2 * SECONDS.ONE_DAY;
  const existing = await db
    .prepare(
      `SELECT generated_at, digest_title, digest_text, digest_extended, digest_meta, input_data
         FROM daily_digest
        WHERE generated_at >= ?
          AND json_extract(digest_meta, '$.type') = 'weekly'
        ORDER BY generated_at DESC
        LIMIT 1`,
    )
    .bind(weekStart)
    .first<ExistingWeeklyDigestRow>();
  if (existing) {
    const existingMeta = parseWeeklyDigestMeta(existing.digest_meta, existing.generated_at);
    if (!shouldRetryExistingWeeklyTelegram(existingMeta)) {
      await reportDigestProgress(reportProgress, {
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
    await reportDigestProgress(reportProgress, {
      stage: "telegram-delivery-retry",
      message: "Retrying weekly recap Telegram delivery",
      providerFamily: "telegram-api",
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
    const retryStatus = await deliverWeeklyDigestToTelegram({
      db,
      telegramCreds,
      digestTitle: existing.digest_title,
      digestExtended: existing.digest_extended,
      digestText: existing.digest_text,
      generatedAt: existing.generated_at,
      weekStartLabel: getMetaString(existingMeta, "weekStart") ?? formatIsoDate(existing.generated_at),
      safetyContext: digestSafetyContextFromPersistedInput(existingInput),
      signal,
    });
    await updateWeeklyTelegramDeliveryMeta(db, existing, {
      nowSec: Math.floor(Date.now() / 1000),
      telegramStatus: retryStatus,
    });
    await reportDigestProgress(reportProgress, {
      stage: "complete",
      message: "Completed weekly recap Telegram retry",
      providerFamily: "telegram-api",
      itemsDone: 1,
      itemsTotal: 1,
      metadata: {
        telegramStatus: retryStatus,
      },
    });
    return {
      itemCount: 0,
      metadata: `weekly: existing recap delivery retry, telegram: ${retryStatus}`,
    };
  }

  const recentWeeklyRows = await db
    .prepare(
      `SELECT digest_title, digest_text, digest_meta
       FROM daily_digest
       WHERE json_extract(digest_meta, '$.type') = 'weekly'
       ORDER BY generated_at DESC LIMIT 4`,
    )
    .all<{ digest_title: string | null; digest_text: string; digest_meta: string | null }>();
  const recentWeeklyMeta = buildRecentDigestMeta(recentWeeklyRows.results ?? []).map((entry) => ({
    meta: entry.meta as Record<string, unknown> | null,
    title: entry.title,
    rawText: entry.rawText,
  }));

  await reportDigestProgress(reportProgress, {
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
  // 15-day cutoff + LIMIT 15 captures current + prior weeks for WoW
  // deltas and bounds the result set deterministically even if the dedup
  // guard ever drifts.
  const cutoff = Math.floor(Date.now() / 1000) - 15 * SECONDS.ONE_DAY;
  const dailyRows = await db
    .prepare(
      `WITH latest_daily AS (
         SELECT generated_at, digest_title, digest_text, digest_extended, input_data,
                ROW_NUMBER() OVER (
                  PARTITION BY strftime('%Y-%m-%d', generated_at, 'unixepoch')
                  ORDER BY generated_at DESC
                ) AS row_rank
         FROM daily_digest
         WHERE generated_at >= ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       )
       SELECT generated_at, digest_title, digest_text, digest_extended, input_data
       FROM latest_daily
       WHERE row_rank = 1
       ORDER BY generated_at ASC
       LIMIT 15`,
    )
    .bind(cutoff)
    .all<DailyDigestSourceRow>();

  const allRows = dailyRows.results ?? [];
  // Snap the split to a UTC day boundary (= last Tuesday 00:00 UTC given
  // the Monday 08:05 cron slot). Day-level snap removes sub-second drift
  // ambiguity between weekly runs, unlike a rolling `now - 7d` window.
  const nowSec = Math.floor(Date.now() / 1000);
  const todayTs = nowSec - (nowSec % SECONDS.ONE_DAY);
  const weekBoundary = todayTs - 6 * SECONDS.ONE_DAY;
  const currentRows = allRows.filter((r) => r.generated_at >= weekBoundary);
  const priorRows = allRows.filter((r) => r.generated_at < weekBoundary);
  await reportDigestProgress(reportProgress, {
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
    await reportDigestProgress(reportProgress, {
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
    return { metadata: `skipped: only ${currentRows.length} daily digests available in current week (need 5+)` };
  }

  let safetyContext: DigestSafetyContext;
  try {
    safetyContext = await loadDigestSafetyContext(db, signal);
  } catch (error) {
    console.error(JSON.stringify({
      scope: "weekly-recap",
      message: "Failed to resolve active Safety Score source",
      error: error instanceof Error ? error.message : String(error),
    }));
    safetyContext = {
      status: "unavailable",
      expectedModel: "v9",
      identity: null,
      publishedAt: null,
      reason: "source-load-failed",
    };
  }
  const weeklyData = buildWeeklyInputData(currentRows, priorRows, safetyContext);
  if (!weeklyData) {
    await reportDigestProgress(reportProgress, {
      stage: "input-unavailable",
      message: "Failed to build weekly recap input data",
      providerFamily: "pharos-d1",
      itemsDone: currentRows.length,
      itemsTotal: currentRows.length,
    });
    return { metadata: "skipped: failed to build weekly input data" };
  }

  const userPrompt = buildWeeklyPrompt(weeklyData, recentWeeklyMeta);
  await reportDigestProgress(reportProgress, {
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
        maxTokens: 64000,
      },
    },
  });

  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: WEEKLY_SYSTEM_PROMPT,
    userPrompt,
    // Matches daily-digest's 64k floor for Opus 4.7 adaptive thinking at
    // xhigh effort — same runaway-thinking failure mode would apply here.
    maxTokens: 64000,
    signal,
    logPrefix: "weekly-recap",
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
      recentMeta: recentWeeklyMeta,
      leadRequirements: buildWeeklyLeadRequirements(weeklyData),
      forbidSafetyClaims: safetyContext.status !== "available",
    },
  });
  if (digestCopy.kind === "circuit-open") {
    await reportDigestProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping weekly recap because Anthropic circuit is open",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "anthropic-circuit-open",
      },
    });
    return { metadata: "skipped: anthropic circuit open" };
  }
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
  const qualityIssues = [...digestCopy.qualityIssues, ...safetyCopyIssues];
  const hasBlockingQualityIssues =
    digestCopy.hasBlockingQualityIssues || safetyCopyIssues.length > 0;
  await reportDigestProgress(reportProgress, {
    stage: "llm-generation-complete",
    message: "Received weekly recap copy from Anthropic",
    providerFamily: "anthropic",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        qualityIssues: qualityIssues.length,
      },
      blockingQualityIssues: hasBlockingQualityIssues,
    },
  });

  const initialDigestMeta = encodeWeeklyDigestMeta(digestCopy.digestMeta, {
    generatedAt: nowSec,
    nowSec,
    telegramDelivered: false,
    telegramDeliveryStatus: "pending",
    weeklyDefaults: {
      type: "weekly",
      periodType: weeklyData.periodType,
      weekStart: weeklyData.weekStartDate,
      weekEnd: weeklyData.weekEndDate,
      safetyContext: weeklyData.safetyContext,
    },
  });

  // Store
  await reportDigestProgress(reportProgress, {
    stage: "persistence",
    message: "Persisting weekly recap row",
    providerFamily: "d1",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      cursor: {
        weekStart: weeklyData.weekStartDate,
        weekEnd: weeklyData.weekEndDate,
      },
    },
  });
  // Hard quality failures are stored for inspection but never published.
  const storedDigestMeta = hasBlockingQualityIssues
    ? markDigestMetaBlocked(initialDigestMeta)
    : initialDigestMeta;

  await insertDigestRecord({
    db,
    generatedAt: nowSec,
    digestText: digestCopy.digestText,
    digestTitle: digestCopy.digestTitle || null,
    inputData: weeklyData,
    digestExtended: digestCopy.digestExtended || null,
    digestMeta: storedDigestMeta,
    signal,
  });
  throwIfAborted(signal);

  // Post to Telegram
  const qualityGateStatus = hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  throwIfAborted(signal);
  await reportDigestProgress(reportProgress, {
    stage: "telegram-delivery",
    message: "Delivering weekly recap to Telegram",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      qualityGateStatus,
    },
  });
  const telegramStatus =
    qualityGateStatus ??
    (await deliverWeeklyDigestToTelegram({
      db,
      telegramCreds,
      digestTitle: digestCopy.digestTitle || null,
      digestExtended: digestCopy.digestExtended || null,
      digestText: digestCopy.digestText,
      generatedAt: nowSec,
      weekStartLabel: weeklyData.weekStartDate,
      safetyContext,
      signal,
    }));
  await updateWeeklyTelegramDeliveryMeta(
    db,
    {
      generated_at: nowSec,
      digest_meta: storedDigestMeta,
    },
    {
      nowSec,
      telegramStatus,
    },
  );

  const qualityMetadata = formatQualityMetadata(qualityIssues);

  await reportDigestProgress(reportProgress, {
    stage: "complete",
    message: "Completed weekly recap generation",
    providerFamily: "digest",
    itemsDone: 1,
    itemsTotal: 1,
    metadata: {
      countTotals: {
        textChars: digestCopy.digestText.length,
        extendedChars: digestCopy.digestExtended.length,
        qualityIssues: qualityIssues.length,
      },
      telegramStatus,
      usedRawTextFallback: digestCopy.usedRawTextFallback,
    },
  });
  return {
    itemCount: 1,
    ...(digestCopy.usedRawTextFallback ||
    hasBlockingQualityIssues ||
    safetyContext.status === "unavailable"
      ? { status: "degraded" as const }
      : {}),
    metadata: `weekly: ${digestCopy.digestText.length} chars, telegram: ${telegramStatus}${digestCopy.usedRawTextFallback ? ", degraded: raw-text-fallback" : ""}${qualityMetadata}`,
  };
}
