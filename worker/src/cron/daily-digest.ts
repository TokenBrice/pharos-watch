import { logWorkerEventArgs } from "../lib/structured-log";
import { recordCronFailure, type CronProgressReporter, type CronResult } from "../lib/cron-logger";
import { throwIfAborted } from "../lib/abort";
import { postDigestTweet, type TwitterCreds } from "../lib/twitter";
import type { TelegramCreds } from "../lib/telegram";
import { SECONDS } from "../lib/time-constants";
import { formatIsoDate } from "@shared/lib/format";
import { CIRCUIT_SOURCE } from "../lib/constants";
import { deleteCache, getCache, setCache } from "../lib/db-cache";
import { DEPEG_LIFECYCLE_FLAGS_CACHE_KEY } from "../lib/depeg-lifecycle";
import { prepareTelegramDigestAppendices, type PreparedTelegramDigestAppendices } from "../lib/telegram-digest-appendices";
import {
  deliverTelegramDigestEdition,
  enqueueTelegramDigestEdition,
} from "../lib/telegram-digest-outbox";
import { buildDailyDigestInput } from "./daily-digest/input";
import { formatStandingConditionsLine } from "./daily-digest/cause-context";
import { buildUserPrompt, SYSTEM_PROMPT } from "./daily-digest/prompt";
import { insertDigestRecord, markDigestMetaBlocked, requestDigestCopy, runDigestChannelDelivery } from "./digest/platform";
import {
  runTelegramDigestDeliveryWithPermit,
  mapTelegramDigestPermittedDelivery,
  type TelegramDigestPermittedDelivery,
} from "./telegram-digest-transport";
import { reportCronProgress } from "../lib/cron-progress";
import { formatQualityMetadata } from "./digest/quality-metadata";
import { logDailyDigestLlmCall } from "./daily-digest/runtime-helpers";
import { NON_BLOCKED_DIGEST_SQL_FILTER, NON_INTERNAL_DIGEST_SQL_FILTER, NON_WEEKLY_DIGEST_SQL_FILTER } from "../lib/digest-sql-filters";
import { buildCriticalDailyLeadRequirements } from "./daily-digest/critical-lead-requirements";
import { attachDigestEditorialAudit } from "./daily-digest/digest-intelligence";
import type { DigestValidationIssue } from "./daily-digest/response";
import { logWorkerEvent } from "../lib/structured-log";
import {
  checkDigestSafetyContextForDelivery,
  findUnboundDigestSafetyClaimMarkers,
} from "../lib/digest-safety-context";
import {
  buildDigestSafetyMapCaptions,
  DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY,
  parseDigestSafetyMapDeferral,
  resolveDigestSafetyMap,
  type DigestSafetyMapDeferral,
  type DigestSafetyMapResolution,
} from "../lib/digest-safety-map";
import { safeJsonParse } from "../lib/api-cache-read";
import type { DigestInputData } from "@shared/types/digest";
import {
  deliverTwitterDigestWithLedger,
  TwitterDigestLedgerPersistenceError,
} from "../lib/twitter-digest-ledger";

export { classifyRegime } from "./daily-digest/prompt";

const TWITTER_SENT_MARKER_PREFIX = "daily-digest:twitter-sent:";

function getTwitterSentMarkerKey(date: string): string {
  return `${TWITTER_SENT_MARKER_PREFIX}${date}`;
}

async function clearSafetyMapDeferral(db: D1Database): Promise<void> {
  try {
    await deleteCache(db, DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY);
  } catch (err) {
    logWorkerEvent({
      scope: "handler",
      level: "warn",
      event: "digest_safety_map_deferral_clear_failed",
      job: "daily-digest",
      message: "Failed to clear the Safety Score map deferral intent",
      error: err,
    });
  }
}

/**
 * Record (or refresh) today's withheld-digest intent. Throws on write failure
 * so a gate-time deferral that cannot be persisted surfaces as a cron error
 * instead of silently losing the retry loop.
 */
async function upsertSafetyMapDeferral(
  db: D1Database,
  date: string,
  reason: string,
  nowSec: number,
  signal?: AbortSignal,
): Promise<DigestSafetyMapDeferral> {
  const previousRow = await getCache(db, DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY, signal);
  const previous = previousRow ? parseDigestSafetyMapDeferral(previousRow.value) : null;
  const carried = previous?.date === date ? previous : null;
  const deferral: DigestSafetyMapDeferral = {
    date,
    reason,
    firstDeferredAtSec: carried?.firstDeferredAtSec ?? nowSec,
    attempts: (carried?.attempts ?? 0) + 1,
  };
  await setCache(db, DIGEST_SAFETY_MAP_DEFERRAL_CACHE_KEY, JSON.stringify(deferral), signal);
  return deferral;
}

interface DeliverDigestToChannelsInput {
  db: D1Database;
  twitterCreds: TwitterCreds | null;
  telegramCreds: TelegramCreds | null;
  digestTitle: string;
  digestText: string;
  digestExtended: string;
  safetyContext: DigestInputData["safetyContext"] | null;
  standingConditions: DigestInputData["standingConditions"];
  editionNumber: number | null;
  digestDate: string;
  nowSec: number;
  safetyMap: DigestSafetyMapResolution | null;
  qualityGateStatus: string | null;
  degradedReasons: string[];
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
}

interface DigestChannelDeliveryOutcome {
  tweetStatus: string;
  telegramStatus: string;
  /**
   * True when neither channel needs another attempt: the tweet reached a
   * terminal state (sent, deliberately skipped, or a manual-reconciliation
   * ledger state) and the Telegram edition is either delivered, owned by the
   * outbox drain, or deliberately not sent. False keeps the safety-map
   * deferral intent alive so the digest-trigger-poll slot resumes delivery.
   */
  deliveryComplete: boolean;
}

/**
 * Channel statuses a later poll retry can still resolve. The safety-identity
 * withholds count as retryable: they occur before any ledger claim, and the
 * identity check can heal within the day — the digest stays unsent until it
 * does (or the date rolls over), never posted with unverifiable claims.
 */
function isRetryableChannelStatus(status: string): boolean {
  return status.startsWith("failed:")
    || status === "skipped: circuit-open"
    || status === "skipped: in-flight"
    || status === "skipped: stale-safety-identity"
    || status === "skipped: safety-identity-unavailable";
}

/**
 * Shared Twitter/Telegram delivery for a daily edition, used by the fresh
 * generation path and by `resumeDailyDigestDelivery`. The caller resolves the
 * Safety Score map first; this function never posts a mapped edition without
 * its attachment (`postDigestTweet` aborts on upload failure, and the Telegram
 * payload embeds the immutable dated map URL).
 */
async function deliverDigestToChannels(input: DeliverDigestToChannelsInput): Promise<DigestChannelDeliveryOutcome> {
  const { db, twitterCreds, telegramCreds, editionNumber, digestDate, nowSec, qualityGateStatus, degradedReasons, signal, reportProgress } = input;
  const safetyMapImageUrl = input.safetyMap?.kind === "available" ? input.safetyMap.imageUrl : null;
  const safetyMapCaptions = input.safetyMap?.kind === "available" && input.safetyContext?.status === "available"
    ? buildDigestSafetyMapCaptions(input.safetyMap.manifest.mapSummary)
    : null;
  throwIfAborted(signal);
  await reportCronProgress(reportProgress, {
    stage: "twitter-delivery",
    message: "Delivering daily digest to Twitter/X",
    providerFamily: "twitter-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      qualityGateStatus,
    },
  });
  const tweetStatus = qualityGateStatus ?? await runDigestChannelDelivery({
    db,
    circuitSource: CIRCUIT_SOURCE.TWITTER_API,
    creds: twitterCreds,
    logPrefix: "daily-digest",
    channelLabel: "Twitter",
    deliver: async (creds) => {
      if (input.safetyContext) {
        const safetyCheck = await checkDigestSafetyContextForDelivery(db, input.safetyContext, signal);
        if (safetyCheck.kind !== "ok") {
          const reason = safetyCheck.kind === "stale"
            ? "stale-safety-identity"
            : "safety-identity-unavailable";
          degradedReasons.push(reason);
          return `skipped: ${reason}`;
        }
      }
      const markerKey = getTwitterSentMarkerKey(digestDate);
      try {
        const delivery = await deliverTwitterDigestWithLedger(
          db,
          markerKey,
          editionNumber,
          nowSec,
          () => postDigestTweet(
            input.digestTitle,
            input.digestText,
            creds,
            editionNumber,
            safetyMapImageUrl,
            safetyMapCaptions?.tweetHook,
          ),
          signal,
        );
        if (delivery.status === "skipped") return `skipped: ${delivery.reason}`;
      } catch (err) {
        if (err instanceof TwitterDigestLedgerPersistenceError) {
          degradedReasons.push("twitter-send-marker-write");
          recordCronFailure("daily-digest", err, { metadata: { stage: "twitter-send-marker-write" } });
        }
        throw err;
      }
      return "ok";
    },
  });
  throwIfAborted(signal);
  await reportCronProgress(reportProgress, {
    stage: "telegram-delivery",
    message: "Delivering daily digest to Telegram",
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      qualityGateStatus,
      twitterStatus: tweetStatus,
    },
  });
  const telegramEditionKey = `daily:${digestDate}`;
  let telegramAppendices: PreparedTelegramDigestAppendices | null = null;
  let telegramOutboxReady = false;
  if (!qualityGateStatus && telegramCreds) {
    try {
      try {
        telegramAppendices = await prepareTelegramDigestAppendices(db);
      } catch (err) {
        degradedReasons.push("telegram-appendix-state");
        logWorkerEventArgs("handler", "error", "[daily-digest] Failed to prepare Telegram digest appendices:", err);
      }
      const enqueueResult = await enqueueTelegramDigestEdition(db, {
        editionKey: telegramEditionKey,
        digestKind: "daily",
        digestGeneratedAt: nowSec,
        targetChatId: telegramCreds.chatId,
        title: input.digestTitle,
        // The chronic ledger keeps demoted ongoing stories visible as one
        // deterministic line instead of another narrated day-count headline.
        extended: (() => {
          const standingLine = formatStandingConditionsLine(input.standingConditions);
          return standingLine ? `${input.digestExtended}\n\n${standingLine}` : input.digestExtended;
        })(),
        date: digestDate,
        editionNumber,
        appendixHtml: telegramAppendices?.appendixHtml ?? null,
        imageUrl: safetyMapImageUrl,
        mapAppendixHtml: safetyMapCaptions?.telegramAppendixHtml,
        successActions: telegramAppendices?.successActions ?? [],
        safetyContext: input.safetyContext ?? {
          status: "unavailable",
          expectedModel: "v9",
          identity: null,
          publishedAt: null,
          reason: "source-load-failed",
        },
      }, signal);
      if (!enqueueResult.payloadMatched && enqueueResult.state !== "sent") {
        degradedReasons.push("telegram-outbox-payload-mismatch");
        recordCronFailure("daily-digest", new Error("Immutable Telegram digest edition differs"), {
          metadata: { stage: "telegram-outbox-payload-mismatch", editionKey: telegramEditionKey },
        });
      }
      telegramOutboxReady = true;
    } catch (err) {
      degradedReasons.push("telegram-outbox-write");
      recordCronFailure("daily-digest", err, { metadata: { stage: "telegram-outbox-write" } });
    }
  }
  const telegramStatus = qualityGateStatus ?? await runTelegramDigestDeliveryWithPermit({
    db,
    creds: telegramCreds,
    owner: "daily-digest",
    editionKey: telegramEditionKey,
    signal,
    deliver: async (creds): Promise<TelegramDigestPermittedDelivery> => {
      if (!telegramOutboxReady) throw new Error("Telegram digest outbox was not persisted");
      const delivery = await deliverTelegramDigestEdition(db, creds, telegramEditionKey, signal);
      const appendixSuffix = telegramAppendices?.metadata.hasAppendix
        ? `+appendix(cemetery=${telegramAppendices.metadata.cemeteryDetected},tracked=${telegramAppendices.metadata.trackedDetected},prelaunch=${telegramAppendices.metadata.preLaunchDetected})`
        : "";
      return mapTelegramDigestPermittedDelivery(delivery, {
        success: `ok${appendixSuffix}`,
        alreadySent: "skipped: already-sent",
      });
    },
  });
  // Every unresolved channel state must survive this invocation: the deferral
  // intent keeps the digest-trigger-poll resume loop alive for today, whether
  // the map gate deferred earlier or a post-gate send failed. A completed day
  // retires the intent.
  const telegramUnresolved = !qualityGateStatus && Boolean(telegramCreds) && !telegramOutboxReady;
  const deliveryComplete = !isRetryableChannelStatus(tweetStatus) && !telegramUnresolved;
  if (twitterCreds || telegramCreds) {
    if (deliveryComplete) {
      await clearSafetyMapDeferral(db);
    } else {
      const unresolvedReason = isRetryableChannelStatus(tweetStatus)
        ? `delivery-incomplete:${tweetStatus.startsWith("failed:") ? "twitter-failed" : tweetStatus.replace("skipped: ", "")}`
        : "delivery-incomplete:telegram-outbox";
      try {
        await upsertSafetyMapDeferral(db, digestDate, unresolvedReason, nowSec, signal);
      } catch (err) {
        logWorkerEvent({
          scope: "handler",
          level: "error",
          event: "digest_safety_map_deferral_persist_failed",
          job: "daily-digest",
          message: "Failed to persist the unresolved-delivery deferral intent",
          error: err,
          metadata: { date: digestDate, reason: unresolvedReason },
        });
        // Without the durable intent the poll loop cannot resume delivery, so
        // the run must fail loudly rather than end as a quiet degraded day.
        throw err;
      }
    }
  }
  if (degradedReasons.includes("twitter-send-marker-write")) {
    throw new Error("Twitter daily digest marker write failed");
  }
  if (degradedReasons.includes("telegram-outbox-write")) {
    throw new Error("Telegram daily digest outbox write failed");
  }
  return {
    tweetStatus,
    telegramStatus,
    deliveryComplete,
  };
}

export async function generateDailyDigest(
  db: D1Database,
  anthropicApiKey: string | null,
  twitterCreds: TwitterCreds | null = null,
  force = false,
  telegramCreds: TelegramCreds | null = null,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<CronResult> {
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
    await reportCronProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping daily digest because Anthropic credentials are missing",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "missing-api-key",
      },
    });
    return { metadata: "skipped: no API key" };
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

  // Fail-closed map gate: the published digest must carry today's Safety
  // Score map on every social channel. When the map is not live yet, the run
  // withholds everything — no digest row, no LLM spend, no post — and records
  // a deferral intent that the digest-trigger-poll slot retries every five
  // minutes until the map publishes. A day whose map never publishes keeps
  // its digest unsent and is dead-lettered at the date rollover. `force`
  // bypasses only the recency check above, never this gate.
  let safetyMap: DigestSafetyMapResolution | null = null;
  if (twitterCreds || telegramCreds) {
    const gateNowSec = Math.floor(Date.now() / 1000);
    const gateDate = formatIsoDate(gateNowSec);
    safetyMap = await resolveDigestSafetyMap(gateDate, gateNowSec, signal);
    if (safetyMap.kind === "unavailable") {
      const deferral = await upsertSafetyMapDeferral(db, gateDate, safetyMap.reason, gateNowSec, signal);
      logWorkerEvent({
        scope: "handler",
        level: "warn",
        event: "daily_digest_safety_map_deferred",
        job: "daily-digest",
        message: "Daily digest withheld: today's Safety Score map is not published",
        metadata: { reason: safetyMap.reason, date: gateDate, attempts: deferral.attempts, forced: force },
      });
      await reportCronProgress(reportProgress, {
        stage: "skipped",
        message: "Withholding daily digest until today's Safety Score map publishes",
        providerFamily: "digest",
        itemsDone: 0,
        itemsTotal: 1,
        metadata: {
          skipped: "safety-map-unavailable",
          reason: safetyMap.reason,
        },
      });
      return { status: "degraded", itemCount: 0, metadata: `deferred: safety-map-${safetyMap.reason}` };
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
        maxTokens: 64000,
      },
    },
  });
  const digestCopy = await requestDigestCopy({
    db,
    anthropicApiKey,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: userPromptContent,
    // Opus xhigh needs this floor; see digest/platform.ts for the effort rationale.
    maxTokens: 64000,
    signal,
    logPrefix: "daily-digest",
    validationProfile: {
      kind: "daily",
      recentMeta: recentMeta.map((entry) => ({
        meta: entry.meta as Record<string, unknown> | null,
        title: entry.title,
        rawText: entry.rawText,
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
    await reportCronProgress(reportProgress, {
      stage: "skipped",
      message: "Skipping daily digest because Anthropic circuit is open",
      providerFamily: "anthropic",
      itemsDone: 0,
      itemsTotal: 1,
      metadata: {
        skipped: "anthropic-circuit-open",
      },
    });
    return { status: "degraded", itemCount: 0, metadata: "skipped: anthropic circuit open" };
  }
  const unboundSafetyClaimMarkers = findUnboundDigestSafetyClaimMarkers(
    inputData.safetyContext,
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
  if (safetyCopyIssues.length > 0) {
    degradedReasons.push("unbound-safety-copy");
  }
  await reportCronProgress(reportProgress, {
    stage: "llm-generation-complete",
    message: "Received daily digest copy from Anthropic",
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

  const storedInputData = attachDigestEditorialAudit({
    inputData,
    digestMeta: digestCopy.digestMeta,
    qualityIssues,
    leadRequirements,
  });
  const now = Math.floor(Date.now() / 1000);
  const digestDate = formatIsoDate(now);
  await reportCronProgress(reportProgress, {
    stage: "persistence",
    message: "Persisting daily digest row",
    providerFamily: "d1",
    itemsDone: 0,
    itemsTotal: 1,
  });
  await insertDigestRecord({
    db,
    generatedAt: now,
    digestText: digestCopy.digestText,
    digestTitle: digestCopy.digestTitle || null,
    inputData: storedInputData,
    digestExtended: digestCopy.digestExtended || null,
    // Hard quality failures are stored for inspection but never published:
    // the blocked flag keeps the row out of public reads and numbering.
    digestMeta: hasBlockingQualityIssues
      ? markDigestMetaBlocked(digestCopy.digestMeta)
      : digestCopy.digestMeta,
    signal,
  });
  throwIfAborted(signal);
  // SAFETY: NON_WEEKLY_DIGEST_SQL_FILTER is a hardcoded SQL fragment, not derived from user input.
  const countResult = await db
    .prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${NON_WEEKLY_DIGEST_SQL_FILTER}`)
    .all<{ cnt: number }>();
  throwIfAborted(signal);
  const editionNumber = (countResult.results?.[0] as { cnt: number } | undefined)?.cnt ?? null;
  const qualityGateStatus = hasBlockingQualityIssues ? "skipped: quality-gate" : null;
  throwIfAborted(signal);
  const delivery = await deliverDigestToChannels({
    db,
    twitterCreds,
    telegramCreds,
    digestTitle: digestCopy.digestTitle,
    digestText: digestCopy.digestText,
    digestExtended: digestCopy.digestExtended,
    safetyContext: inputData.safetyContext ?? null,
    standingConditions: inputData.standingConditions,
    editionNumber,
    digestDate,
    nowSec: now,
    safetyMap,
    qualityGateStatus,
    degradedReasons,
    signal,
    reportProgress,
  });
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
    },
  });
  logWorkerEventArgs("handler", "info", `[daily-digest] Generated and stored digest: "${digestCopy.digestTitle}" (${digestCopy.digestText.length} chars + ${digestCopy.digestExtended.length} extended), tweet: ${tweetStatus}, telegram: ${telegramStatus}${qualityMetadata}`);
  const lifecycleMetadata = lifecycleFlags.length > 0
    ? `, lifecycle-review: ${lifecycleFlags.map((flag) => `${flag.symbol}:${flag.kind}`).join("|")}`
    : "";
  return {
    itemCount: 1,
    ...(degradedReasons.length > 0 || hasBlockingQualityIssues ? { status: "degraded" as const } : {}),
    metadata: `${digestCopy.digestText.length} chars, tweet: ${tweetStatus}, telegram: ${telegramStatus}${degradedReasons.length > 0 ? `, degraded: ${degradedReasons.join("|")}` : ""}${qualityMetadata}${lifecycleMetadata}`,
  };
}

export type ResumeDailyDigestDeliveryOutcome =
  | { kind: "resumed"; tweetStatus: string; telegramStatus: string; deliveryComplete: boolean }
  | { kind: "no-publishable-digest" };

/**
 * Delivery-only recovery for a day whose digest row exists but whose social
 * delivery is unresolved (for example a Twitter media-upload abort after the
 * map gate passed). Regenerating through `generateDailyDigest` would mint a
 * duplicate edition; this path re-runs delivery from the stored copy instead.
 * Twitter stays duplicate-safe through the send-marker ledger, and a Telegram
 * edition already in the outbox is left to the drain slot.
 */
export async function resumeDailyDigestDelivery(
  db: D1Database,
  twitterCreds: TwitterCreds | null,
  telegramCreds: TelegramCreds | null,
  safetyMap: DigestSafetyMapResolution,
  signal?: AbortSignal,
  reportProgress?: CronProgressReporter,
): Promise<ResumeDailyDigestDeliveryOutcome> {
  const nowSec = Math.floor(Date.now() / 1000);
  const digestDate = formatIsoDate(nowSec);
  const dayStartSec = Math.floor(Date.parse(`${digestDate}T00:00:00Z`) / 1000);
  // SAFETY: the digest SQL filters are hardcoded fragments, not user input.
  const row = await db
    .prepare(
      `SELECT digest_text, digest_title, digest_extended, input_data FROM daily_digest
       WHERE generated_at >= ? AND (${NON_WEEKLY_DIGEST_SQL_FILTER}) AND (${NON_INTERNAL_DIGEST_SQL_FILTER}) AND (${NON_BLOCKED_DIGEST_SQL_FILTER})
       ORDER BY generated_at DESC LIMIT 1`,
    )
    .bind(dayStartSec)
    .first<{ digest_text: string; digest_title: string | null; digest_extended: string | null; input_data: string | null }>();
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
    // loudly for manual outbox reconciliation instead of spinning the
    // deferral until midnight.
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
  const outcome = await deliverDigestToChannels({
    db,
    twitterCreds,
    // An already-enqueued Telegram edition is immutable and owned by the
    // outbox drain; re-enqueueing would diff a rebuilt payload against the
    // stored one, so the resume path leaves that channel alone.
    telegramCreds: alreadyEnqueued ? null : telegramCreds,
    digestTitle: row.digest_title ?? "",
    digestText: row.digest_text,
    digestExtended: row.digest_extended ?? "",
    safetyContext: storedInput?.safetyContext ?? null,
    standingConditions: storedInput?.standingConditions,
    editionNumber,
    digestDate,
    nowSec,
    safetyMap,
    qualityGateStatus: null,
    degradedReasons,
    signal,
    reportProgress,
  });
  logWorkerEvent({
    scope: "handler",
    level: outcome.deliveryComplete ? "info" : "warn",
    event: "daily_digest_delivery_resumed",
    job: "daily-digest",
    message: "Resumed daily digest delivery from the stored edition",
    metadata: {
      date: digestDate,
      tweetStatus: outcome.tweetStatus,
      telegramStatus: outboxRow ? `outbox-${outboxRow.state}` : outcome.telegramStatus,
      deliveryComplete: outcome.deliveryComplete,
      degradedReasons,
    },
  });
  return {
    kind: "resumed",
    tweetStatus: outcome.tweetStatus,
    telegramStatus: outboxRow ? `outbox-${outboxRow.state}` : outcome.telegramStatus,
    deliveryComplete: outcome.deliveryComplete,
  };
}
