import { AlertReserveSourceEnvelopeSchema, type AlertReserveSourceEnvelope } from "@shared/types/status/telegram";
import type { ReserveAlertSourceState } from "@shared/types/status";
import { tryParseJson } from "./json-parse";

export const ALERT_RESERVE_SOURCE_GENERATION = "reserve-alert-source-v2";
const ALERT_RESERVE_SOURCE_STALE_PRODUCER_INTERVALS = 2;

type CachedValue = { value: string; updatedAt: number } | null;

export type { AlertReserveSourceEnvelope } from "@shared/types/status";

export interface AlertReserveSourceAssessment {
  state: ReserveAlertSourceState;
  ageSeconds: number | null;
  generation: string | null;
  envelope: AlertReserveSourceEnvelope | null;
}

function parseAlertReserveSourceEnvelope(cached: CachedValue): AlertReserveSourceEnvelope | null {
  if (!cached) return null;
  const parsed = AlertReserveSourceEnvelopeSchema.safeParse(tryParseJson(cached.value));
  return parsed.success ? parsed.data : null;
}

export function assessAlertReserveSourceCache(
  cached: CachedValue,
  options: {
    nowSec: number;
    producerIntervalSec: number;
    expectedGeneration?: string;
  },
): AlertReserveSourceAssessment {
  if (!cached) {
    return { state: "missing", ageSeconds: null, generation: null, envelope: null };
  }

  const envelope = parseAlertReserveSourceEnvelope(cached);
  if (!envelope) {
    return { state: "corrupt", ageSeconds: null, generation: null, envelope: null };
  }

  const ageSeconds = options.nowSec - envelope.publishedAt;
  if (ageSeconds < 0) {
    return {
      state: "corrupt",
      ageSeconds,
      generation: envelope.generation,
      envelope,
    };
  }

  const expectedGeneration = options.expectedGeneration ?? ALERT_RESERVE_SOURCE_GENERATION;
  if (envelope.generation !== expectedGeneration) {
    return {
      state: "wrong-generation",
      ageSeconds,
      generation: envelope.generation,
      envelope,
    };
  }

  if (ageSeconds > options.producerIntervalSec * ALERT_RESERVE_SOURCE_STALE_PRODUCER_INTERVALS) {
    return {
      state: "stale",
      ageSeconds,
      generation: envelope.generation,
      envelope,
    };
  }

  if (!envelope.continuous) {
    return {
      state: "recovering",
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

export function buildAlertReserveSourceEnvelope(
  driftIds: readonly string[],
  previous: CachedValue,
  options: {
    nowSec: number;
    producerIntervalSec: number;
    generation?: string;
    observedIds: readonly string[];
    unavailableIds: readonly string[];
  },
): AlertReserveSourceEnvelope {
  const generation = options.generation ?? ALERT_RESERVE_SOURCE_GENERATION;
  const previousEnvelope = parseAlertReserveSourceEnvelope(previous);
  const previousAgeSec = previousEnvelope == null
    ? Number.POSITIVE_INFINITY
    : options.nowSec - previousEnvelope.publishedAt;
  const continuous =
    previousEnvelope?.generation === generation &&
    previousAgeSec >= 0 &&
    previousAgeSec <= options.producerIntervalSec * ALERT_RESERVE_SOURCE_STALE_PRODUCER_INTERVALS;
  const observedSince: Record<string, number> = {};
  for (const id of options.observedIds) {
    observedSince[id] = continuous ? previousEnvelope!.observedSince[id] ?? options.nowSec : options.nowSec;
  }

  return {
    generation,
    publishedAt: options.nowSec,
    continuous,
    driftIds: [...new Set(driftIds)].sort(),
    observedSince,
    unavailableIds: [...new Set(options.unavailableIds)].sort(),
  };
}
