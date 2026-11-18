import { logWorkerEventArgs } from "./structured-log";
import { z } from "zod";
import { getCache } from "./db-cache";
import { decodeCachedJson } from "./cache-json";
import { decodePublishedPegType, StablecoinListResponseSchema, type StablecoinData, type StablecoinListResponse } from "@shared/types/supply";

const StablecoinsReferenceEnvelopeSchema = StablecoinListResponseSchema.pick({
  fxReferenceObservations: true, selectedPegReferences: true, fxAdmissionCoverageGeneration: true,
});

/** A delayed publisher cannot install a companion for a superseded equal-clock cohort. */
export function prepareStablecoinsGenerationCompanion(
  db: D1Database, key: string, value: string, updatedAt: number, generation: string,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO cache (key, value, updated_at) SELECT ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM cache WHERE key = 'stablecoins' AND updated_at = ?
      AND json_extract(value, '$.fxAdmissionCoverageGeneration') = ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).bind(key, value, updatedAt, updatedAt, generation);
}

// Validate critical fields only -- passthrough preserves all upstream data
const StablecoinEntrySchema = z.object({
  id: z.string().min(1),
  symbol: z.string().min(1),
  name: z.string().optional(),
  price: z.number().nullable().optional(),
  pegType: z.string().optional(),
  circulating: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** Validate a single stablecoin entry. Returns the entry if valid, null if malformed. */
export function validateStablecoinEntry(entry: unknown): StablecoinData | null {
  const result = StablecoinEntrySchema.safeParse(entry);
  return result.success ? (result.data as StablecoinData) : null;
}

export type StablecoinsCachePayload = StablecoinListResponse;

export type StablecoinsCacheContract = "published" | "critical-fields";

export type StablecoinsCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload-shape"
  | "missing-pegged-assets"
  | "filtered-malformed-entries"
  | "published-contract-invalid"
  | "cache-read-failed";

export interface StablecoinsCacheLoadOk {
  kind: "ok";
  payload: StablecoinsCachePayload;
  updatedAt: number;
  filteredCount?: number;
  /** Published payload validation aliases legacy clocks; capture needs their original absence. */
  missingPriceObservedAtIds?: ReadonlySet<string>;
}

export interface StablecoinsCacheLoadDegraded {
  kind: "degraded";
  reason: StablecoinsCacheFailureReason;
  payload: StablecoinsCachePayload | null;
  updatedAt: number | null;
  filteredCount?: number;
}

export interface StablecoinsCacheLoadError {
  kind: "error";
  reason: StablecoinsCacheFailureReason;
  updatedAt: number | null;
}

export type StablecoinsCacheLoadResult =
  | StablecoinsCacheLoadOk
  | StablecoinsCacheLoadDegraded
  | StablecoinsCacheLoadError;

export interface LoadStablecoinsCacheOptions {
  mode?: "strict" | "lenient";
  contract?: StablecoinsCacheContract;
  preloadedCache?: Awaited<ReturnType<typeof getCache>>;
}

interface StablecoinsCacheDecodePayload {
  payload: StablecoinsCachePayload;
  filteredCount: number;
  missingPriceObservedAtIds?: ReadonlySet<string>;
}

function toFxFallbackRates(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validateAndFilterArray(rawArray: unknown[]): { assets: StablecoinData[]; filteredCount: number } | null {
  const validated = rawArray
    .map((entry: unknown) => validateStablecoinEntry(entry))
    .filter((e): e is StablecoinData => e !== null);

  if (validated.length === 0) {
    return null;
  }

  if (validated.length < rawArray.length) {
    logWorkerEventArgs("lib", "warn", `[stablecoins-cache] Filtered ${rawArray.length - validated.length} malformed entries`);
  }

  return {
    assets: validated,
    filteredCount: rawArray.length - validated.length,
  };
}

function normalizePayload(
  parsed: unknown,
  contract: StablecoinsCacheContract,
):
  | ({ kind: "ok" } & StablecoinsCacheDecodePayload)
  | { kind: "degraded"; reason: "filtered-malformed-entries"; payload: StablecoinsCachePayload; filteredCount: number }
  | { kind: "error"; reason: StablecoinsCacheFailureReason } {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "error", reason: "invalid-payload-shape" };
  }

  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.peggedAssets)) {
    return { kind: "error", reason: "missing-pegged-assets" };
  }

  if (contract === "published") {
    const result = StablecoinListResponseSchema.safeParse(parsed);
    if (!result.success) {
      return { kind: "error", reason: "published-contract-invalid" };
    }
    const missingPriceObservedAtIds = new Set<string>();
    for (const row of obj.peggedAssets) {
      if (!("priceObservedAt" in row)) missingPriceObservedAtIds.add(row.id);
    }
    return {
      kind: "ok",
      payload: result.data,
      filteredCount: 0,
      ...(missingPriceObservedAtIds.size ? { missingPriceObservedAtIds } : {}),
    };
  }

  const validated = validateAndFilterArray(obj.peggedAssets);
  if (validated === null) {
    return { kind: "error", reason: "missing-pegged-assets" };
  }

  const evidence = StablecoinsReferenceEnvelopeSchema.safeParse(obj);
  if (!evidence.success) return { kind: "error", reason: "published-contract-invalid" };
  const payload = {
    peggedAssets: validated.assets,
    fxFallbackRates: toFxFallbackRates(obj.fxFallbackRates),
    ...evidence.data,
  };

  if (validated.filteredCount > 0) {
    return {
      kind: "degraded",
      reason: "filtered-malformed-entries",
      payload,
      filteredCount: validated.filteredCount,
    };
  }

  return {
    kind: "ok",
    payload,
    filteredCount: 0,
  };
}

function toFailure(
  reason: StablecoinsCacheFailureReason,
  updatedAt: number | null,
): StablecoinsCacheLoadError {
  return {
    kind: "error",
    reason,
    updatedAt,
  };
}

export function hasUsableStablecoinsPayload(
  result: StablecoinsCacheLoadResult,
): result is StablecoinsCacheLoadOk | (StablecoinsCacheLoadDegraded & { payload: StablecoinsCachePayload }) {
  return (result.kind === "ok" || result.kind === "degraded")
    && result.payload != null
    && result.payload.peggedAssets.length > 0;
}

export async function loadStablecoinsCache(
  db: D1Database,
  options: LoadStablecoinsCacheOptions = {},
): Promise<StablecoinsCacheLoadResult> {
  const mode = options.mode ?? "strict";
  const contract = options.contract ?? "critical-fields";
  let cacheRow = options.preloadedCache;
  try {
    if (cacheRow === undefined) cacheRow = await getCache(db, "stablecoins");
  } catch {
    return toFailure("cache-read-failed", null);
  }
  const decoded = decodeCachedJson<StablecoinsCacheDecodePayload, StablecoinsCacheFailureReason>(
    cacheRow,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        const normalized = normalizePayload(parsed, contract);
        if (normalized.kind === "ok") {
          const { kind: _kind, ...payload } = normalized;
          return { ok: true, payload };
        }
        if (normalized.kind === "degraded") {
          return {
            ok: false,
            reason: normalized.reason,
            payload: {
              payload: normalized.payload,
              filteredCount: normalized.filteredCount,
            },
          };
        }
        return { ok: false, reason: normalized.reason };
      },
    },
  );

  const xagm = decoded.payload?.payload.peggedAssets.find((asset) => asset.id === "xagm-matrixdock");
  if (xagm?.pegType !== undefined) xagm.pegType = decodePublishedPegType(xagm.id, xagm.pegType);
  if (!decoded.ok) {
    if (decoded.payload != null && mode === "lenient") {
      return {
        kind: "degraded",
        reason: decoded.reason,
        payload: decoded.payload.payload,
        updatedAt: decoded.updatedAt,
        filteredCount: decoded.payload.filteredCount,
      };
    }
    return toFailure(decoded.reason, decoded.updatedAt);
  }

  return {
    kind: "ok",
    ...decoded.payload,
    updatedAt: decoded.updatedAt ?? 0,
  };
}
