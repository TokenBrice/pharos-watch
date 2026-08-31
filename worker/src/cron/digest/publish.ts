import type { DigestSafetyContext } from "@shared/types/digest";
import { throwIfAborted } from "../../lib/abort";
import { CIRCUIT_SOURCE } from "../../lib/constants";
import { recordCronFailure, type CronProgressReporter } from "../../lib/cron-logger";
import {
  buildDigestSafetyMapCaptions,
  type DigestSafetyMapResolution,
} from "../../lib/digest-safety-map";
import {
  checkDigestSafetyContextForDelivery,
} from "../../lib/digest-safety-context";
import type { TelegramCreds } from "../../lib/telegram";
import type { TelegramDigestSuccessAction } from "../../lib/telegram-digest-appendices";
import {
  deliverTelegramDigestEdition,
  enqueueTelegramDigestEdition,
} from "../../lib/telegram-digest-outbox";
import { postDigestTweet, type TwitterCreds } from "../../lib/twitter";
import {
  deliverTwitterDigestWithLedger,
  TwitterDigestLedgerPersistenceError,
} from "../../lib/twitter-digest-ledger";
import { logWorkerEvent } from "../../lib/structured-log";
import { reportCronProgress } from "../../lib/cron-progress";
import { NON_WEEKLY_DIGEST_SQL_FILTER } from "../../lib/digest-sql-filters";
import {
  classifyDigestChannelStatus,
  insertDigestRecord,
  markDigestMetaBlocked,
  runDigestChannelDelivery,
  type DigestChannelDisposition,
} from "./platform";
import {
  mapTelegramDigestPermittedDelivery,
  runTelegramDigestDeliveryWithPermit,
  type TelegramDigestPermittedDelivery,
} from "../telegram-digest-transport";

type DigestKind = "daily" | "weekly";

export interface DigestCredentialDiagnostics {
  twitterMissing?: readonly string[];
  telegramMissing?: readonly string[];
}

interface DigestTwitterPublication {
  creds: TwitterCreds | null;
  markerKey: string;
  required?: boolean;
  missingCredentialNames?: readonly string[];
}

interface DigestTelegramPublication {
  creds: TelegramCreds | null;
  editionKey: string;
  title?: string;
  routeDate?: string;
  appendixHtml?: string | null;
  /** Caller-owned channel additions; text is escaped with the digest body. */
  extraSections?: readonly {
    kind: "text" | "html";
    content: string;
  }[];
  successActions?: readonly TelegramDigestSuccessAction[];
  required?: boolean;
  missingCredentialNames?: readonly string[];
  successStatus?: string;
  alreadySentStatus?: string;
}

interface DigestEditionDeliveryInput {
  db: D1Database;
  kind: DigestKind;
  generatedAt: number;
  deliveryAt?: number;
  digestDate: string;
  editionNumber: number | null;
  copy: { title: string; text: string; extended: string };
  safetyContext: DigestSafetyContext | null;
  qualityGateStatus: string | null;
  degradedReasons: string[];
  safetyMap: DigestSafetyMapResolution | null;
  twitter: DigestTwitterPublication | null;
  telegram: DigestTelegramPublication | null;
  signal?: AbortSignal;
  reportProgress?: CronProgressReporter;
}

export interface PublishDigestEditionInput extends DigestEditionDeliveryInput {
  copy: DigestEditionDeliveryInput["copy"] & { meta: string | null };
  inputData: unknown;
}

export interface DigestPublicationOutcome {
  editionNumber: number | null;
  tweetStatus: string;
  telegramStatus: string;
  dispositions: Record<"twitter" | "telegram", DigestChannelDisposition>;
}

function unavailableSafetyContext(): DigestSafetyContext {
  return {
    status: "unavailable",
    expectedModel: "v9",
    identity: null,
    publishedAt: null,
    reason: "source-load-failed",
  };
}

function resolveDisposition(
  status: string,
  channel: { creds: unknown | null; required?: boolean } | null,
): DigestChannelDisposition {
  const classified = classifyDigestChannelStatus(status);
  if (/\b(?:execution_unknown|failed_permanent)\b/.test(status)) {
    return "terminal-unsent";
  }
  return classified === "not-configured" && channel?.required && !channel.creds
    ? "terminal-unsent"
    : classified;
}

function recordTerminalChannelOutcome(
  kind: DigestKind,
  channel: "twitter" | "telegram",
  status: string,
  missingCredentialNames: readonly string[] = [],
): void {
  logWorkerEvent({
    scope: "handler",
    level: "error",
    event: "digest_channel_terminal_unsent",
    job: kind === "daily" ? "daily-digest" : "weekly-recap",
    provider: channel === "twitter" ? "twitter-api" : "telegram-api",
    message: `${kind} digest ${channel} delivery reached a terminal unsent state`,
    metadata: {
      channel,
      status,
      ...(missingCredentialNames.length > 0 ? { missingCredentialNames } : {}),
    },
  });
}

export async function deliverDigestEdition(
  input: DigestEditionDeliveryInput,
): Promise<DigestPublicationOutcome> {
  const job = input.kind === "daily" ? "daily-digest" : "weekly-recap";
  const map = input.safetyMap?.kind === "available" ? input.safetyMap : null;
  const mapCaptions = map && input.safetyContext?.status === "available"
    ? buildDigestSafetyMapCaptions(
        map.manifest.mapSummary,
        map.freshness,
        map.ageDays,
      )
    : null;

  throwIfAborted(input.signal);
  await reportCronProgress(input.reportProgress, {
    stage: "twitter-delivery",
    message: `Delivering ${input.kind} digest to Twitter/X`,
    providerFamily: "twitter-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: { qualityGateStatus: input.qualityGateStatus },
  });
  const tweetStatus = input.qualityGateStatus ?? await runDigestChannelDelivery({
    db: input.db,
    circuitSource: CIRCUIT_SOURCE.TWITTER_API,
    creds: input.twitter?.creds ?? null,
    logPrefix: job,
    channelLabel: "Twitter",
    deliver: async (creds) => {
      if (input.safetyContext) {
        const safetyCheck = await checkDigestSafetyContextForDelivery(
          input.db,
          input.safetyContext,
          input.signal,
        );
        if (safetyCheck.kind !== "ok") {
          const reason = safetyCheck.kind === "stale"
            ? "stale-safety-identity"
            : "safety-identity-unavailable";
          input.degradedReasons.push(reason);
          return `skipped: ${reason}`;
        }
      }
      if (!input.twitter) return "skipped: no-creds";
      try {
        const delivery = await deliverTwitterDigestWithLedger(
          input.db,
          input.twitter.markerKey,
          input.editionNumber,
          input.deliveryAt ?? input.generatedAt,
          () => postDigestTweet(
            input.copy.title,
            input.copy.text,
            creds,
            input.editionNumber,
            map?.imageUrl ?? null,
            mapCaptions?.tweetHook ?? null,
          ),
          input.signal,
        );
        return delivery.status === "skipped"
          ? `skipped: ${delivery.reason}`
          : "ok";
      } catch (error) {
        if (error instanceof TwitterDigestLedgerPersistenceError) {
          input.degradedReasons.push("twitter-send-marker-write");
        }
        throw error;
      }
    },
  });

  throwIfAborted(input.signal);
  await reportCronProgress(input.reportProgress, {
    stage: "telegram-delivery",
    message: `Delivering ${input.kind} digest to Telegram`,
    providerFamily: "telegram-api",
    itemsDone: 0,
    itemsTotal: 1,
    metadata: {
      qualityGateStatus: input.qualityGateStatus,
      twitterStatus: tweetStatus,
    },
  });
  let telegramOutboxReady = false;
  if (!input.qualityGateStatus && input.telegram?.creds) {
    try {
      const textSections = input.telegram.extraSections
        ?.filter((section) => section.kind === "text" && section.content.trim())
        .map((section) => section.content) ?? [];
      const htmlSections = input.telegram.extraSections
        ?.filter((section) => section.kind === "html" && section.content.trim())
        .map((section) => section.content) ?? [];
      const enqueueResult = await enqueueTelegramDigestEdition(input.db, {
        editionKey: input.telegram.editionKey,
        digestKind: input.kind,
        digestGeneratedAt: input.generatedAt,
        targetChatId: input.telegram.creds.chatId,
        title: input.telegram.title ?? input.copy.title,
        extended: [input.copy.extended, ...textSections].filter(Boolean).join("\n\n"),
        date: input.telegram.routeDate ?? input.digestDate,
        editionNumber: input.editionNumber,
        appendixHtml: input.telegram.appendixHtml ?? null,
        mapImageUrl: map?.imageUrl ?? null,
        mapDate: map?.manifest.date ?? null,
        mapAppendixHtml: htmlSections.join("\n\n") || null,
        successActions: input.telegram.successActions ?? [],
        safetyContext: input.safetyContext ?? unavailableSafetyContext(),
      }, input.signal);
      if (!enqueueResult.payloadMatched && enqueueResult.state !== "sent") {
        input.degradedReasons.push("telegram-outbox-payload-mismatch");
        recordCronFailure(job, new Error("Immutable Telegram digest edition differs"), {
          metadata: {
            stage: "telegram-outbox-payload-mismatch",
            editionKey: input.telegram.editionKey,
          },
        });
      }
      telegramOutboxReady = true;
    } catch (error) {
      input.degradedReasons.push("telegram-outbox-write");
      recordCronFailure(job, error, { metadata: { stage: "telegram-outbox-write" } });
    }
  }
  const telegramStatus = input.qualityGateStatus ?? await runTelegramDigestDeliveryWithPermit({
    db: input.db,
    creds: input.telegram?.creds ?? null,
    owner: job,
    editionKey: input.telegram?.editionKey ?? `${input.kind}:${input.digestDate}`,
    signal: input.signal,
    deliver: async (creds): Promise<TelegramDigestPermittedDelivery> => {
      if (!input.telegram || !telegramOutboxReady) {
        throw new Error("Telegram digest outbox was not persisted");
      }
      const delivery = await deliverTelegramDigestEdition(
        input.db,
        creds,
        input.telegram.editionKey,
        input.signal,
      );
      return mapTelegramDigestPermittedDelivery(delivery, {
        success: input.telegram.successStatus ?? "ok",
        alreadySent: input.telegram.alreadySentStatus ?? "skipped: already-sent",
      });
    },
  });

  if (input.degradedReasons.includes("twitter-send-marker-write")) {
    throw new Error(`Twitter ${input.kind} digest marker write failed`);
  }
  if (input.degradedReasons.includes("telegram-outbox-write")) {
    throw new Error(`Telegram ${input.kind} digest outbox write failed`);
  }

  const dispositions = {
    twitter: resolveDisposition(tweetStatus, input.twitter),
    telegram: resolveDisposition(telegramStatus, input.telegram),
  } satisfies Record<"twitter" | "telegram", DigestChannelDisposition>;
  if (dispositions.twitter === "terminal-unsent") {
    recordTerminalChannelOutcome(
      input.kind,
      "twitter",
      tweetStatus,
      input.twitter?.missingCredentialNames,
    );
  }
  if (dispositions.telegram === "terminal-unsent") {
    recordTerminalChannelOutcome(
      input.kind,
      "telegram",
      telegramStatus,
      input.telegram?.missingCredentialNames,
    );
  }
  return {
    editionNumber: input.editionNumber,
    tweetStatus,
    telegramStatus,
    dispositions,
  };
}

export async function publishDigestEdition(
  input: PublishDigestEditionInput,
): Promise<DigestPublicationOutcome> {
  await reportCronProgress(input.reportProgress, {
    stage: "persistence",
    message: `Persisting ${input.kind} digest row`,
    providerFamily: "d1",
    itemsDone: 0,
    itemsTotal: 1,
  });
  const storedMeta = input.qualityGateStatus
    ? markDigestMetaBlocked(input.copy.meta)
    : input.copy.meta;
  await insertDigestRecord({
    db: input.db,
    generatedAt: input.generatedAt,
    digestText: input.copy.text,
    digestTitle: input.copy.title || null,
    inputData: input.inputData,
    digestExtended: input.copy.extended || null,
    digestMeta: storedMeta,
    signal: input.signal,
  });
  throwIfAborted(input.signal);

  let editionNumber = input.editionNumber;
  if (input.kind === "daily" && editionNumber == null) {
    const countResult = await input.db
      .prepare(`SELECT COUNT(*) as cnt FROM daily_digest WHERE ${NON_WEEKLY_DIGEST_SQL_FILTER}`)
      .all<{ cnt: number }>();
    throwIfAborted(input.signal);
    editionNumber = countResult.results?.[0]?.cnt ?? null;
  }

  return deliverDigestEdition({
    ...input,
    editionNumber,
  });
}
