import type { ReserveAlertSourceState } from "@shared/types/status";
import { tryParseJson } from "./json-parse";

export const ALERT_RESERVE_SOURCE_GENERATION = "reserve-alert-source-v1";
const ALERT_RESERVE_SOURCE_STALE_PRODUCER_INTERVALS = 2;

type CachedValue = { value: string; updatedAt: number } | null;

export interface AlertReserveSourceEnvelope {
  generation: string;
  publishedAt: number;
  continuous: boolean;
  driftIds: string[];
}

export interface AlertReserveSourceAssessment {
  state: ReserveAlertSourceState;
  ageSeconds: number | null;
  generation: string | null;
  envelope: AlertReserveSourceEnvelope | null;
}

function parseEnvelope(cached: CachedValue): AlertReserveSourceEnvelope | null {
  if (!cached) return null;

  const parsed = tryParseJson(cached.value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.generation !== "string" ||
    record.generation.length === 0 ||
    typeof record.publishedAt !== "number" ||
    !Number.isInteger(record.publishedAt) ||
    record.publishedAt <= 0 ||
    typeof record.continuous !== "boolean" ||
    !Array.isArray(record.driftIds) ||
    !record.driftIds.every((id) => typeof id === "string" && id.length > 0)
  ) {
    return null;
  }

  const driftIds = record.driftIds as string[];
  if (new Set(driftIds).size !== driftIds.length) return null;

  return {
    generation: record.generation,
    publishedAt: record.publishedAt,
    continuous: record.continuous,
    driftIds,
  };
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

  const envelope = parseEnvelope(cached);
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
  },
): AlertReserveSourceEnvelope {
  const generation = options.generation ?? ALERT_RESERVE_SOURCE_GENERATION;
  const previousEnvelope = parseEnvelope(previous);
  const previousAgeSec = previousEnvelope == null
    ? Number.POSITIVE_INFINITY
    : options.nowSec - previousEnvelope.publishedAt;
  const continuous =
    previousEnvelope?.generation === generation &&
    previousAgeSec >= 0 &&
    previousAgeSec <= options.producerIntervalSec * ALERT_RESERVE_SOURCE_STALE_PRODUCER_INTERVALS;

  return {
    generation,
    publishedAt: options.nowSec,
    continuous,
    driftIds: [...new Set(driftIds)].sort(),
  };
}
