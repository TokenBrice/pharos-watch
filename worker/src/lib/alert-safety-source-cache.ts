import { SAFETY_SCORE_VERSION } from "@shared/lib/safety-score-version";
import type { ReportCard } from "@shared/types";

export const ALERT_SAFETY_SOURCE_CACHE_KEY = "alert:safety-source-cache";
export const ALERT_SAFETY_SOURCE_SCHEMA_VERSION = "1";
export const ALERT_SAFETY_SOURCE_STALE_PRODUCER_INTERVALS = 2;

export type AlertSafetySourceState = "ok" | "missing" | "corrupt" | "stale" | "wrong-generation";

export interface AlertSafetySourceRow {
  grade: string;
  score: number | null;
  methodologyVersion: string | null;
}

export type AlertSafetySourceSnapshot = Record<string, AlertSafetySourceRow>;

export interface AlertSafetySourceEnvelope {
  generation: string;
  methodologyVersion: string;
  publishedAt: number;
  snapshot: AlertSafetySourceSnapshot;
}

export interface AlertSafetySnapshotEnvelope {
  generation: string;
  snapshot: AlertSafetySourceSnapshot;
}

export interface AlertSafetySourceAssessment {
  state: AlertSafetySourceState;
  ageSeconds: number | null;
  generation: string | null;
  envelope: AlertSafetySourceEnvelope | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isSnapshotRow(value: unknown): value is AlertSafetySourceRow {
  const record = asRecord(value);
  if (!record) return false;
  return typeof record.grade === "string" &&
    ("score" in record ? record.score === null || typeof record.score === "number" : false) &&
    ("methodologyVersion" in record
      ? record.methodologyVersion === null || typeof record.methodologyVersion === "string"
      : false);
}

function isSnapshot(value: unknown): value is AlertSafetySourceSnapshot {
  const record = asRecord(value);
  if (!record) return false;
  return Object.values(record).every(isSnapshotRow);
}

function parseCachedValue(cached: { value: string; updatedAt: number } | null): unknown | null {
  if (!cached) return null;
  try {
    return JSON.parse(cached.value) as unknown;
  } catch {
    return null;
  }
}

export function getAlertSafetySourceGeneration(methodologyVersion = SAFETY_SCORE_VERSION): string {
  return `safety-${methodologyVersion}-alert-source-v${ALERT_SAFETY_SOURCE_SCHEMA_VERSION}`;
}

export function buildAlertSafetySourceSnapshot(
  cards: ReportCard[],
  methodologyVersion: string,
): AlertSafetySourceSnapshot {
  const snapshot: AlertSafetySourceSnapshot = {};

  for (const card of cards) {
    if (card.isDefunct) continue;
    snapshot[card.id] = {
      grade: card.overallGrade,
      score: card.overallScore ?? null,
      methodologyVersion,
    };
  }

  return snapshot;
}

export function buildAlertSafetySourceEnvelope(
  cards: ReportCard[],
  methodologyVersion: string,
  publishedAt: number,
): AlertSafetySourceEnvelope {
  return {
    generation: getAlertSafetySourceGeneration(methodologyVersion),
    methodologyVersion,
    publishedAt,
    snapshot: buildAlertSafetySourceSnapshot(cards, methodologyVersion),
  };
}

export function parseAlertSafetySourceEnvelope(
  cached: { value: string; updatedAt: number } | null,
): AlertSafetySourceEnvelope | null {
  const parsed = parseCachedValue(cached);
  const record = asRecord(parsed);
  if (!record) return null;

  const generation = typeof record.generation === "string" ? record.generation : null;
  const methodologyVersion = typeof record.methodologyVersion === "string" ? record.methodologyVersion : null;
  const publishedAt = typeof record.publishedAt === "number" ? record.publishedAt : null;
  const snapshot = isSnapshot(record.snapshot) ? record.snapshot : null;

  if (!generation || !methodologyVersion || publishedAt == null || !snapshot) {
    return null;
  }

  return {
    generation,
    methodologyVersion,
    publishedAt,
    snapshot,
  };
}

export function assessAlertSafetySourceCache(
  cached: { value: string; updatedAt: number } | null,
  options: {
    expectedGeneration?: string;
    nowSec: number;
    producerIntervalSec: number;
  },
): AlertSafetySourceAssessment {
  const expectedGeneration = options.expectedGeneration ?? getAlertSafetySourceGeneration();
  if (!cached) {
    return {
      state: "missing",
      ageSeconds: null,
      generation: null,
      envelope: null,
    };
  }

  const envelope = parseAlertSafetySourceEnvelope(cached);
  if (!envelope) {
    return {
      state: "corrupt",
      ageSeconds: null,
      generation: null,
      envelope: null,
    };
  }

  const ageSeconds = Math.max(0, options.nowSec - envelope.publishedAt);
  if (envelope.generation !== expectedGeneration) {
    return {
      state: "wrong-generation",
      ageSeconds,
      generation: envelope.generation,
      envelope,
    };
  }

  if (ageSeconds > options.producerIntervalSec * ALERT_SAFETY_SOURCE_STALE_PRODUCER_INTERVALS) {
    return {
      state: "stale",
      ageSeconds,
      generation: envelope.generation,
      envelope,
    };
  }

  return {
    state: "ok",
    ageSeconds,
    generation: envelope.generation,
    envelope,
  };
}

export function buildAlertSafetySnapshotEnvelope(
  snapshot: AlertSafetySourceSnapshot,
  generation: string,
): AlertSafetySnapshotEnvelope {
  return {
    generation,
    snapshot,
  };
}

export function parseAlertSafetySnapshotEnvelope(
  cached: { value: string; updatedAt: number } | null,
): AlertSafetySnapshotEnvelope | null {
  const parsed = parseCachedValue(cached);
  if (isSnapshot(parsed)) {
    return {
      generation: "",
      snapshot: parsed,
    };
  }

  const record = asRecord(parsed);
  if (!record) return null;

  const generation = typeof record.generation === "string" ? record.generation : null;
  const snapshot = isSnapshot(record.snapshot) ? record.snapshot : null;
  if (generation == null || snapshot == null) return null;

  return {
    generation,
    snapshot,
  };
}
