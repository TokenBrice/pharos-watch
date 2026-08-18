import { safetyScorePublicationIdentitiesAreComparable } from "@shared/lib/safety-score-publication";
import { isRecord } from "@shared/lib/type-guards";
import type { SafetyAlertSourceState } from "@shared/types";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import {
  SafetyScorePublicationIdentitySchema,
  type SafetyScorePublicationIdentity,
  type SafetyScoreV9PublicationIdentity,
} from "@shared/types/safety-score-publication";
import { getCache, setCache } from "./db-cache";
import {
  loadActiveSafetyScoreIdentity,
  loadActiveSafetyScoreSource,
  type ActiveSafetyScoreSource,
} from "./safety-score-active-source";
import { SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC } from "./safety-score-v9-consumer-freshness";

const ALERT_SAFETY_V9_SOURCE_GENERATION = "safety-v9-alert-source-v1";

/**
 * Persisted thin projection of the accepted V9 publication for the alert
 * lanes. Decoding the full publication costs a large transient heap spike
 * (gunzip + parse + schema clone of an ~8MB canonical payload), which is far
 * too heavy for a five-minute cadence on a heap-constrained isolate; the
 * publication writer persists this envelope once so alert reads stay small.
 */
export const ALERT_SAFETY_V9_SOURCE_CACHE_KEY = "alert-safety-v9-source";
const ALERT_SAFETY_DETAIL_MAX_CHARS = 160;

export interface AlertSafetyV9ExplainSnapshot {
  reasons: Array<{ code: string; message: string }>;
  bindingCap: { kind: string; limit: number; reason: string } | null;
  weakestPillar: { pillar: string; score: number } | null;
  pillars: Record<
    "backing" | "exit" | "control",
    {
      score: number | null;
      evidenceLevel: string;
      freshness: string;
    }
  >;
}

export interface AlertSafetySourceRow {
  grade: string;
  score: number | null;
  methodologyVersion: string | null;
  operationallyAffected?: boolean;
  v9Explain?: AlertSafetyV9ExplainSnapshot;
}

export type AlertSafetyV9SourceRow = AlertSafetySourceRow & {
  v9Explain: AlertSafetyV9ExplainSnapshot;
};
export type AlertSafetySourceSnapshot = Record<string, AlertSafetySourceRow>;

export interface AlertSafetySourceEnvelope {
  generation: string;
  safetyScoreIdentity: SafetyScoreV9PublicationIdentity;
  publicationGenerationId: string;
  methodologyVersion: string;
  publishedAt: number;
  snapshot: AlertSafetySourceSnapshot;
}

export interface AlertSafetySnapshotEnvelope {
  generation: string;
  safetyScoreIdentity?: SafetyScorePublicationIdentity;
  snapshot: AlertSafetySourceSnapshot;
}

export interface AlertSafetySourceAssessment {
  state: SafetyAlertSourceState;
  ageSeconds: number | null;
  generation: string | null;
  envelope: AlertSafetySourceEnvelope | null;
  failureReason?: string;
}

function truncateDetail(value: string): string {
  if (value.length <= ALERT_SAFETY_DETAIL_MAX_CHARS) return value;
  return `${value.slice(0, ALERT_SAFETY_DETAIL_MAX_CHARS - 3)}...`;
}

function parseV9Explain(value: unknown): AlertSafetyV9ExplainSnapshot | null {
  if (!isRecord(value)) return null;
  if (
    !Array.isArray(value.reasons) ||
    !value.reasons.every(
      (reason) =>
        isRecord(reason) &&
        typeof reason.code === "string" &&
        typeof reason.message === "string",
    )
  ) {
    return null;
  }
  const bindingCap =
    value.bindingCap === null
      ? null
      : isRecord(value.bindingCap) &&
          typeof value.bindingCap.kind === "string" &&
          typeof value.bindingCap.limit === "number" &&
          Number.isFinite(value.bindingCap.limit) &&
          typeof value.bindingCap.reason === "string"
        ? {
            kind: value.bindingCap.kind,
            limit: value.bindingCap.limit,
            reason: value.bindingCap.reason,
          }
        : undefined;
  const weakestPillar =
    value.weakestPillar === null
      ? null
      : isRecord(value.weakestPillar) &&
          typeof value.weakestPillar.pillar === "string" &&
          typeof value.weakestPillar.score === "number" &&
          Number.isFinite(value.weakestPillar.score)
        ? {
            pillar: value.weakestPillar.pillar,
            score: value.weakestPillar.score,
          }
        : undefined;
  if (
    bindingCap === undefined ||
    weakestPillar === undefined ||
    !isRecord(value.pillars)
  ) {
    return null;
  }

  const pillars = {} as AlertSafetyV9ExplainSnapshot["pillars"];
  for (const pillar of ["backing", "exit", "control"] as const) {
    const candidate = value.pillars[pillar];
    if (
      !isRecord(candidate) ||
      !(
        candidate.score === null ||
        (typeof candidate.score === "number" && Number.isFinite(candidate.score))
      ) ||
      typeof candidate.evidenceLevel !== "string" ||
      typeof candidate.freshness !== "string"
    ) {
      return null;
    }
    pillars[pillar] = {
      score: candidate.score,
      evidenceLevel: candidate.evidenceLevel,
      freshness: candidate.freshness,
    };
  }

  return {
    reasons: value.reasons.map((reason) => ({
      code: String((reason as Record<string, unknown>).code),
      message: String((reason as Record<string, unknown>).message),
    })),
    bindingCap,
    weakestPillar,
    pillars,
  };
}

function parseSnapshot(value: unknown): AlertSafetySourceSnapshot | null {
  if (!isRecord(value)) return null;
  const snapshot: AlertSafetySourceSnapshot = {};
  for (const [id, candidate] of Object.entries(value)) {
    if (
      !isRecord(candidate) ||
      typeof candidate.grade !== "string" ||
      !(
        candidate.score === null ||
        (typeof candidate.score === "number" && Number.isFinite(candidate.score))
      ) ||
      !(
        candidate.methodologyVersion === null ||
        typeof candidate.methodologyVersion === "string"
      ) ||
      !(
        candidate.operationallyAffected === undefined ||
        typeof candidate.operationallyAffected === "boolean"
      )
    ) {
      return null;
    }
    const v9Explain = parseV9Explain(candidate.v9Explain);
    if (!v9Explain) return null;
    snapshot[id] = {
      grade: candidate.grade,
      score: candidate.score,
      methodologyVersion: candidate.methodologyVersion,
      ...(candidate.operationallyAffected === undefined
        ? {}
        : {
            operationallyAffected:
              candidate.operationallyAffected,
          }),
      v9Explain,
    };
  }
  return snapshot;
}

export function getAlertSafetyV9SourceGeneration(
  _methodologyVersion?: string,
): string {
  return ALERT_SAFETY_V9_SOURCE_GENERATION;
}

export function buildActiveAlertSafetyV9SourceEnvelope(
  source: ReportCardsV9CurrentResponse,
): AlertSafetySourceEnvelope | null {
  if (source.publicationHealth.status === "held") return null;
  return buildAlertSafetyV9SourceEnvelopeFromParts({
    cards: source.cards,
    safetyScoreIdentity: source.safetyScoreIdentity,
    publishedAt: source.updatedAt,
  });
}

export function buildAlertSafetyV9SourceEnvelopeFromParts(source: {
  cards: ReportCardsV9CurrentResponse["cards"];
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
          methodologyVersion:
            source.safetyScoreIdentity.methodologyVersion,
          v9Explain: {
            reasons: card.evidence.reasons.map((reason) => ({
              code: reason.code,
              message: truncateDetail(reason.message),
            })),
            bindingCap:
              card.bindingCap === null
                ? null
                : {
                    kind: card.bindingCap.kind,
                    limit: card.bindingCap.limit,
                    reason: truncateDetail(card.bindingCap.reason),
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

export function assessActiveAlertSafetySource(
  activeSource: ActiveSafetyScoreSource,
  options: { nowSec: number },
): AlertSafetySourceAssessment {
  if (activeSource.kind === "error") {
    return {
      state:
        activeSource.reason === "v9-snapshot-unavailable"
          ? "missing"
          : "corrupt",
      ageSeconds: null,
      generation: null,
      envelope: null,
      failureReason: activeSource.reason,
    };
  }

  const envelope = buildActiveAlertSafetyV9SourceEnvelope(
    activeSource.snapshot,
  );
  if (!envelope) {
    return {
      state: "corrupt",
      ageSeconds: null,
      generation: null,
      envelope: null,
      failureReason:
        activeSource.kind === "held"
          ? activeSource.reason
          : "v9-snapshot-invalid",
    };
  }
  return assessAlertSafetyEnvelope(envelope, options.nowSec);
}

export function assessAlertSafetyEnvelope(
  envelope: AlertSafetySourceEnvelope,
  nowSec: number,
): AlertSafetySourceAssessment {
  const ageSeconds = Math.max(0, nowSec - envelope.publishedAt);
  if (ageSeconds > SAFETY_SCORE_V9_CONSUMER_MAX_AGE_SEC) {
    return {
      state: "stale",
      ageSeconds,
      generation: envelope.generation,
      envelope,
      failureReason: "v9-snapshot-stale",
    };
  }
  return {
    state: "ok",
    ageSeconds,
    generation: envelope.generation,
    envelope,
  };
}

export function parsePersistedAlertSafetyV9SourceEnvelope(
  cached: { value: string; updatedAt: number } | null,
): AlertSafetySourceEnvelope | null {
  if (!cached) return null;
  try {
    const parsed: unknown = JSON.parse(cached.value);
    if (
      !isRecord(parsed) ||
      typeof parsed.generation !== "string" ||
      typeof parsed.publicationGenerationId !== "string" ||
      typeof parsed.methodologyVersion !== "string" ||
      typeof parsed.publishedAt !== "number" ||
      !Number.isFinite(parsed.publishedAt)
    ) {
      return null;
    }
    const identity = SafetyScorePublicationIdentitySchema.safeParse(
      parsed.safetyScoreIdentity,
    );
    const snapshot = parseSnapshot(parsed.snapshot);
    if (!identity.success || identity.data.model !== "v9" || !snapshot) return null;
    return {
      generation: parsed.generation,
      safetyScoreIdentity: identity.data,
      publicationGenerationId: parsed.publicationGenerationId,
      methodologyVersion: parsed.methodologyVersion,
      publishedAt: parsed.publishedAt,
      snapshot: snapshot as AlertSafetySourceEnvelope["snapshot"],
    };
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
  // Envelope-first read: when the persisted thin projection matches the
  // active publication identity, the heavy publication decode is skipped
  // entirely. Any mismatch, held or error state, or unparseable envelope
  // falls back to the full decode so behavior stays identical.
  try {
    const identity = await loadActiveSafetyScoreIdentity(db, signal);
    if (identity.kind === "v9" && identity.safetyScoreIdentity) {
      const cached = parsePersistedAlertSafetyV9SourceEnvelope(
        await getCache(db, ALERT_SAFETY_V9_SOURCE_CACHE_KEY, signal),
      );
      if (
        cached &&
        cached.generation === ALERT_SAFETY_V9_SOURCE_GENERATION &&
        cached.publicationGenerationId ===
          identity.safetyScoreIdentity.publicationGenerationId
      ) {
        return assessAlertSafetyEnvelope(cached, nowSec);
      }
    }
  } catch {
    // Fall through to the authoritative full decode.
  }
  return assessActiveAlertSafetySource(
    await loadActiveSafetyScoreSource(db, signal),
    { nowSec },
  );
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
    const parsed: unknown = JSON.parse(cached.value);
    if (!isRecord(parsed) || typeof parsed.generation !== "string") {
      return null;
    }
    const identity = SafetyScorePublicationIdentitySchema.safeParse(
      parsed.safetyScoreIdentity,
    );
    const snapshot = parseSnapshot(parsed.snapshot);
    if (!identity.success || !snapshot) return null;
    return {
      generation: parsed.generation,
      safetyScoreIdentity: identity.data,
      snapshot,
    };
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
