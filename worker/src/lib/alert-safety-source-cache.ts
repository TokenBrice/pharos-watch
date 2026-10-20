import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import { isRecord } from "@shared/lib/type-guards";
import { resolveV9PublicWitnessText } from "@shared/types/safety-score-v9-public-witness-texts";
import type { SafetyAlertSourceState } from "@shared/types";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import type { SafetyScoreV9CurrentCard } from "@shared/types/safety-score-v9-public";
import { projectV9CompactPartialEvidence } from "@shared/types/safety-score-v9-causes";
import {
  AlertSafetySourceEnvelopeSchema,
  AlertSafetySnapshotEnvelopeSchema,
  type AlertSafetyV9ExplainSnapshot,
  type AlertSafetySourceSnapshot,
  type AlertSafetySourceEnvelope,
  type AlertSafetySnapshotEnvelope,
} from "@shared/types/status/telegram";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
} from "@shared/types/safety-score-publication";
import { getCache, setCache } from "./db-cache";
import {
  SAFETY_SCORE_V9_CACHE_KEYS,
  parseSafetyScoreV9PublicationHealthCache,
} from "./safety-score-v9/publication-health";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./safety-score-v9/consumer-freshness";

export const ALERT_SAFETY_V9_SOURCE_GENERATION = "safety-v9-alert-source-v2";

/**
 * Persisted thin projection of the accepted V9 publication for the alert
 * lanes. Decoding the full publication costs a large transient heap spike
 * (gunzip + parse + schema clone of an ~8MB canonical payload), which is far
 * too heavy for a five-minute cadence on a heap-constrained isolate; the
 * publication writer persists this envelope once so alert reads stay small.
 */
export const ALERT_SAFETY_V9_SOURCE_CACHE_KEY = "alert-safety-v9-source";
const ALERT_SAFETY_DETAIL_MAX_CHARS = 160;
const ALERT_SAFETY_HOLD_REASON_CODE_LIMIT = 5;


export interface AlertSafetySourceAssessment {
  state: SafetyAlertSourceState;
  ageSeconds: number | null;
  generation: string | null;
  envelope: AlertSafetySourceEnvelope | null;
  failureReason?: string;
  heldSinceSec?: number | null;
  holdReasonCodes?: string[];
  sourcePublicationGenerationId: string | null;
  acceptedPublicationGenerationId: string | null;
  freshnessMaxAgeSec: number;
  assessedAtSec: number;
}

function sourceDiagnostics(
  nowSec: number,
  envelope: Pick<AlertSafetySourceEnvelope, "publishedAt" | "generation" | "publicationGenerationId"> | null = null,
  acceptedPublicationGenerationId: string | null = null,
): Pick<AlertSafetySourceAssessment,
  "ageSeconds" | "generation" | "sourcePublicationGenerationId" |
  "acceptedPublicationGenerationId" | "freshnessMaxAgeSec" | "assessedAtSec"
> {
  return {
    ageSeconds: envelope == null ? null : Math.max(0, nowSec - envelope.publishedAt),
    generation: envelope?.generation ?? null,
    sourcePublicationGenerationId: envelope?.publicationGenerationId ?? null,
    acceptedPublicationGenerationId,
    freshnessMaxAgeSec: SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC,
    assessedAtSec: nowSec,
  };
}

function heldPublicationDiagnostics(
  health: ReportCardsV9CurrentResponse["publicationHealth"],
): Pick<AlertSafetySourceAssessment, "heldSinceSec" | "holdReasonCodes"> {
  return {
    heldSinceSec: health.heldSinceSec,
    holdReasonCodes: health.reasons
      .slice(0, ALERT_SAFETY_HOLD_REASON_CODE_LIMIT)
      .map((reason) => reason.code),
  };
}

function truncateDetail(value: string): string {
  if (value.length <= ALERT_SAFETY_DETAIL_MAX_CHARS) return value;
  return `${value.slice(0, ALERT_SAFETY_DETAIL_MAX_CHARS - 3)}...`;
}


export function buildAlertSafetyV9SourceEnvelopeFromParts(source: {
  cards: readonly SafetyScoreV9CurrentCard[];
  safetyScoreIdentity: ReportCardsV9CurrentResponse["safetyScoreIdentity"];
  publishedAt: number;
}): AlertSafetySourceEnvelope {
  return {
    generation: ALERT_SAFETY_V9_SOURCE_GENERATION,
    safetyScoreIdentity: source.safetyScoreIdentity,
    publicationGenerationId:
      source.safetyScoreIdentity.publicationGenerationId,
    methodologyVersion: source.safetyScoreIdentity.methodologyVersion,
    publishedAt: source.publishedAt,
    snapshot: Object.fromEntries(
      source.cards.map((card) => [
        card.id,
        {
          grade: card.grade,
          score: card.score,
          ratingStatus: card.ratingStatus,
          partialEvidence: projectV9CompactPartialEvidence(card.partialEvidence),
          methodologyVersion:
            source.safetyScoreIdentity.methodologyVersion,
          v9Explain: {
            reasons: card.evidence.reasons.map((reason) => ({
              code: reason.code,
              message: truncateDetail(card.witnessTexts === undefined ? reason.message : resolveV9PublicWitnessText(card, reason.message)),
            })),
            bindingCap:
              card.bindingCap === null
                ? null
                : {
                    kind: card.bindingCap.kind,
                    limit: card.bindingCap.limit,
                    reason: truncateDetail(card.witnessTexts === undefined ? card.bindingCap.reason : resolveV9PublicWitnessText(card, card.bindingCap.reason)),
                  },
            weakestPillar: card.weakestPillar,
            pillars: Object.fromEntries(
              (["backing", "exit", "control"] as const).map((pillar) => [
                pillar,
                {
                  score: card.pillars[pillar].score,
                  evidenceLevel: card.pillars[pillar].evidenceLevel,
                  freshness: card.pillars[pillar].freshness,
                },
              ]),
            ) as AlertSafetyV9ExplainSnapshot["pillars"],
          },
        },
      ]),
    ),
  };
}


export function assessAlertSafetyEnvelope(
  envelope: AlertSafetySourceEnvelope,
  nowSec: number,
): AlertSafetySourceAssessment {
  const diagnostics = sourceDiagnostics(nowSec, envelope, envelope.publicationGenerationId);
  if (diagnostics.ageSeconds != null && diagnostics.ageSeconds > SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC) {
    return {
      state: "stale",
      ...diagnostics,
      envelope,
      failureReason: "v9-snapshot-stale",
    };
  }
  return {
    state: "ok",
    ...diagnostics,
    envelope,
  };
}

export function parsePersistedAlertSafetyV9SourceEnvelope(
  cached: { value: string; updatedAt: number } | null,
): AlertSafetySourceEnvelope | null {
  if (!cached) return null;
  try {
    const parsed = AlertSafetySourceEnvelopeSchema.safeParse(JSON.parse(cached.value));
    if (!parsed.success || parsed.data.generation !== ALERT_SAFETY_V9_SOURCE_GENERATION) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Writes the thin alert projection for the accepted publication. Called by
 * the V9 publication writer, which already holds the response in memory, so
 * no additional decode happens on this path. A held response persists nothing.
 */
export async function persistAlertSafetyV9SourceEnvelope(
  db: D1Database,
  source: Parameters<typeof buildAlertSafetyV9SourceEnvelopeFromParts>[0],
  signal?: AbortSignal,
): Promise<void> {
  const envelope = buildAlertSafetyV9SourceEnvelopeFromParts(source);
  await setCache(db, ALERT_SAFETY_V9_SOURCE_CACHE_KEY, JSON.stringify(envelope), signal);
}

export async function loadActiveAlertSafetySourceAssessment(
  db: D1Database,
  nowSec: number,
  signal?: AbortSignal,
): Promise<AlertSafetySourceAssessment> {
  // Alert reads stay on the compact accepted projection. A missing, old or
  // invalid envelope suppresses alerts; it never inflates the full publication.
  const [healthRead, sourceRead] = await Promise.allSettled([
    getCache(db, SAFETY_SCORE_V9_CACHE_KEYS.publicationHealth, signal),
    getCache(db, ALERT_SAFETY_V9_SOURCE_CACHE_KEY, signal),
  ]);
  const cachedRaw = sourceRead.status === "fulfilled" ? sourceRead.value : null;
  const cached = parsePersistedAlertSafetyV9SourceEnvelope(cachedRaw);
  let health: ReportCardsV9CurrentResponse["publicationHealth"] | null = null;
  let invalidHealth = false;
  if (healthRead.status === "fulfilled" && healthRead.value != null) {
    try {
      health = parseSafetyScoreV9PublicationHealthCache(healthRead.value);
    } catch {
      invalidHealth = true;
    }
  }
  const unavailable = (
    state: "missing" | "corrupt",
    failureReason: string,
  ): AlertSafetySourceAssessment => ({
    ...sourceDiagnostics(nowSec, cached, health?.acceptedPublicationGenerationId ?? null),
    state, failureReason, envelope: null,
    ...(health?.status === "held" ? heldPublicationDiagnostics(health) : {}),
  });
  if (healthRead.status === "rejected" || sourceRead.status === "rejected") {
    return unavailable("corrupt", "v9-snapshot-read-failed");
  }
  if (invalidHealth) return unavailable("corrupt", "v9-snapshot-invalid");
  if (health?.status === "held") return unavailable("corrupt", "v9-publication-held");
  if (cachedRaw === null) return unavailable("missing", "v9-snapshot-unavailable");
  if (cached === null) {
    let raw: unknown;
    try {
      raw = JSON.parse(cachedRaw.value);
    } catch {
      return unavailable("corrupt", "v9-snapshot-invalid");
    }
    return unavailable("corrupt", isRecord(raw) && raw.generation === "safety-v9-alert-source-v1"
      ? "publication-schema-cutover-pending" : "v9-snapshot-invalid");
  }
  if (health === null || cached.publicationGenerationId !== health.acceptedPublicationGenerationId) {
    return unavailable("corrupt", "v9-snapshot-invalid");
  }
  return assessAlertSafetyEnvelope(cached, nowSec);
}

export function buildAlertSafetySnapshotEnvelope(
  snapshot: AlertSafetySourceSnapshot,
  generation: string,
  safetyScoreIdentity: SafetyScorePublicationIdentity,
): AlertSafetySnapshotEnvelope {
  return {
    generation,
    safetyScoreIdentity:
      SafetyScorePublicationIdentitySchema.parse(safetyScoreIdentity),
    snapshot,
  };
}

export function parseAlertSafetySnapshotEnvelope(
  cached: { value: string; updatedAt: number } | null,
): AlertSafetySnapshotEnvelope | null {
  if (!cached) return null;
  try {
    const parsed = AlertSafetySnapshotEnvelopeSchema.safeParse(JSON.parse(cached.value));
    if (!parsed.success || parsed.data.generation !== ALERT_SAFETY_V9_SOURCE_GENERATION) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Policy/build boundaries seed a new baseline instead of emitting movement. */
export function alertSafetyIdentitiesAreComparable(
  left: SafetyScorePublicationIdentity,
  right: SafetyScorePublicationIdentity,
): boolean {
  return safetyScorePublicationIdentitiesAreComparable(left, right);
}
