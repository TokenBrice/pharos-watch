import { z } from "zod";
import { getCache } from "./db-cache";
import { decodeCachedJson } from "./cache-json";
import { recordRuntimeFallbackUsage } from "./runtime-fallback-telemetry";
import { StablecoinListResponseSchema, type StablecoinData, type StablecoinListResponse } from "@shared/types/market";

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
  | "legacy-array-not-allowed"
  | "legacy-array-payload"
  | "filtered-malformed-entries"
  | "published-contract-invalid"
  | "cache-read-failed";

export interface StablecoinsCacheLoadOk {
  kind: "ok";
  payload: StablecoinsCachePayload;
  updatedAt: number;
  filteredCount?: number;
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
  allowLegacyArray?: boolean;
  preloadedCache?: Awaited<ReturnType<typeof getCache>>;
}

interface StablecoinsCacheDecodePayload {
  payload: StablecoinsCachePayload;
  filteredCount: number;
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
    console.warn(`[stablecoins-cache] Filtered ${rawArray.length - validated.length} malformed entries`);
  }

  return {
    assets: validated,
    filteredCount: rawArray.length - validated.length,
  };
}

function normalizePayload(
  parsed: unknown,
  options: {
    allowLegacyArray: boolean;
    contract: StablecoinsCacheContract;
  },
):
  | { kind: "ok"; payload: StablecoinsCachePayload; filteredCount: number }
  | { kind: "degraded"; reason: "legacy-array-payload" | "filtered-malformed-entries"; payload: StablecoinsCachePayload; filteredCount: number }
  | { kind: "error"; reason: StablecoinsCacheFailureReason } {
  if (Array.isArray(parsed)) {
    if (!options.allowLegacyArray) {
      return { kind: "error", reason: "legacy-array-not-allowed" };
    }
    const validated = validateAndFilterArray(parsed);
    if (validated === null) {
      return { kind: "error", reason: "missing-pegged-assets" };
    }
    return {
      kind: "degraded",
      reason: "legacy-array-payload",
      payload: { peggedAssets: validated.assets },
      filteredCount: validated.filteredCount,
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { kind: "error", reason: "invalid-payload-shape" };
  }

  const obj = parsed as { peggedAssets?: unknown; fxFallbackRates?: unknown };
  if (!Array.isArray(obj.peggedAssets)) {
    return { kind: "error", reason: "missing-pegged-assets" };
  }

  if (options.contract === "published") {
    const result = StablecoinListResponseSchema.safeParse(parsed);
    if (!result.success) {
      return { kind: "error", reason: "published-contract-invalid" };
    }
    return {
      kind: "ok",
      payload: result.data,
      filteredCount: 0,
    };
  }

  const validated = validateAndFilterArray(obj.peggedAssets);
  if (validated === null) {
    return { kind: "error", reason: "missing-pegged-assets" };
  }

  const payload = {
    peggedAssets: validated.assets,
    fxFallbackRates: toFxFallbackRates(obj.fxFallbackRates),
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
  const allowLegacyArray = options.allowLegacyArray ?? false;
  const cacheRow = options.preloadedCache !== undefined
    ? options.preloadedCache
    : await getCache(db, "stablecoins");
  const decoded = decodeCachedJson<StablecoinsCacheDecodePayload, StablecoinsCacheFailureReason>(
    cacheRow,
    {
      missingReason: "missing-cache",
      parseErrorReason: "json-parse-failed",
      normalize: (parsed) => {
        const normalized = normalizePayload(parsed, { allowLegacyArray, contract });
        if (normalized.kind === "ok") {
          return {
            ok: true,
            payload: {
              payload: normalized.payload,
              filteredCount: normalized.filteredCount,
            },
          };
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

  if (!decoded.ok) {
    if (decoded.payload != null && mode === "lenient") {
      if (decoded.reason === "legacy-array-payload") {
        recordRuntimeFallbackUsage("stablecoins-cache-legacy-array", {
          updatedAt: decoded.updatedAt,
          filteredCount: decoded.payload.filteredCount,
        });
      }
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
    payload: decoded.payload.payload,
    updatedAt: decoded.updatedAt ?? 0,
    filteredCount: decoded.payload.filteredCount,
  };
}
