import { decodeCachedJson } from "./cache-json";
import { getCache, setCache } from "./db-cache";

interface SafeParseSuccess<T> {
  success: true;
  data: T;
}

interface SafeParseFailure {
  success: false;
  error: { message: string };
}

interface SafeParseSchema<T> {
  safeParse(value: unknown): SafeParseSuccess<T> | SafeParseFailure;
}

export interface VersionedSnapshotCacheReasons<TReason extends string> {
  missingCache: TReason;
  jsonParseFailed: TReason;
  invalidPayload: TReason;
  invalidEnvelope: TReason;
  generationMismatch: TReason;
  methodologyMismatch: TReason;
}

export interface VersionedSnapshotCacheEnvelope<TPayload> {
  generation: number;
  methodologyVersion: string;
  payload: TPayload;
  [key: string]: unknown;
}

export type VersionedSnapshotCacheLoadResult<TPayload, TReason extends string> =
  { kind: "ok"; payload: TPayload; updatedAt: number } | { kind: "error"; reason: TReason; updatedAt: number | null };

type VersionFailure<TReason extends string> = { reason: TReason; message?: string };

export interface VersionedSnapshotCacheOptions<TPayload, TReason extends string> {
  cacheKey: string;
  label: string;
  generation: number;
  methodologyVersion: string;
  schema: SafeParseSchema<TPayload>;
  reasons: VersionedSnapshotCacheReasons<TReason>;
  getUpdatedAt: (payload: TPayload) => number;
  validateEnvelope?: (envelope: VersionedSnapshotCacheEnvelope<unknown>) => TReason | null;
  validatePayload?: (payload: TPayload) => VersionFailure<TReason> | null;
  envelopeExtras?: (payload: TPayload) => Record<string, unknown>;
}

function isEnvelope(value: unknown): value is VersionedSnapshotCacheEnvelope<unknown> {
  return Boolean(value && typeof value === "object" && "payload" in value);
}

export async function loadVersionedSnapshotCache<TPayload, TReason extends string>(
  db: D1Database,
  options: VersionedSnapshotCacheOptions<TPayload, TReason>,
): Promise<VersionedSnapshotCacheLoadResult<TPayload, TReason>> {
  return parseVersionedSnapshotCache(await getCache(db, options.cacheKey), options);
}

export function parseVersionedSnapshotCache<TPayload, TReason extends string>(
  cached: { value: string; updatedAt: number } | null,
  options: VersionedSnapshotCacheOptions<TPayload, TReason>,
): VersionedSnapshotCacheLoadResult<TPayload, TReason> {
  const decoded = decodeCachedJson<TPayload, TReason>(cached, {
    mode: "strict",
    missingReason: options.reasons.missingCache,
    parseErrorReason: options.reasons.jsonParseFailed,
    normalize: (parsed) => {
      if (!isEnvelope(parsed)) {
        return { ok: false, reason: options.reasons.invalidEnvelope };
      }
      if (parsed.generation !== options.generation) {
        return { ok: false, reason: options.reasons.generationMismatch };
      }
      if (parsed.methodologyVersion !== options.methodologyVersion) {
        return { ok: false, reason: options.reasons.methodologyMismatch };
      }
      const envelopeFailure = options.validateEnvelope?.(parsed);
      if (envelopeFailure) {
        return { ok: false, reason: envelopeFailure };
      }

      const result = options.schema.safeParse(parsed.payload);
      if (!result.success) {
        return { ok: false, reason: options.reasons.invalidPayload };
      }

      const payloadFailure = options.validatePayload?.(result.data);
      if (payloadFailure) {
        return { ok: false, reason: payloadFailure.reason };
      }
      return { ok: true, payload: result.data };
    },
  });

  if (!decoded.ok) {
    return { kind: "error", reason: decoded.reason, updatedAt: decoded.updatedAt };
  }
  return { kind: "ok", payload: decoded.payload, updatedAt: options.getUpdatedAt(decoded.payload) };
}

export async function writeVersionedSnapshotCache<TPayload, TReason extends string>(
  db: D1Database,
  snapshot: TPayload,
  options: VersionedSnapshotCacheOptions<TPayload, TReason>,
): Promise<void> {
  await setCache(db, options.cacheKey, buildVersionedSnapshotCacheValue(snapshot, options));
}

export function buildVersionedSnapshotCacheValue<TPayload, TReason extends string>(
  snapshot: TPayload,
  options: VersionedSnapshotCacheOptions<TPayload, TReason>,
): string {
  const result = options.schema.safeParse(snapshot);
  if (!result.success) {
    throw new Error(`Invalid ${options.label} snapshot payload: ${result.error.message}`);
  }

  const payloadFailure = options.validatePayload?.(result.data);
  if (payloadFailure) {
    throw new Error(payloadFailure.message ?? `${options.label} snapshot failed ${payloadFailure.reason}`);
  }

  const envelope: VersionedSnapshotCacheEnvelope<TPayload> = {
    generation: options.generation,
    methodologyVersion: options.methodologyVersion,
    ...(options.envelopeExtras?.(result.data) ?? {}),
    payload: result.data,
  };
  return JSON.stringify(envelope);
}
