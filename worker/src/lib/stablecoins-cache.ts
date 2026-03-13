import { z } from "zod";
import { getCache } from "./db";
import type { StablecoinData } from "@shared/types";

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

export interface StablecoinsCachePayload {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
}

export type StablecoinsCacheFailureReason =
  | "missing-cache"
  | "json-parse-failed"
  | "invalid-payload-shape"
  | "missing-pegged-assets"
  | "legacy-array-not-allowed"
  | "legacy-array-payload";

export interface StablecoinsCacheLoadOk {
  kind: "ok";
  payload: StablecoinsCachePayload;
  updatedAt: number;
}

export interface StablecoinsCacheLoadDegraded {
  kind: "degraded";
  reason: StablecoinsCacheFailureReason;
  payload: StablecoinsCachePayload | null;
  updatedAt: number | null;
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
  allowLegacyArray?: boolean;
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

function validateAndFilterArray(rawArray: unknown[]): StablecoinData[] | null {
  const validated = rawArray
    .map((entry: unknown) => validateStablecoinEntry(entry))
    .filter((e): e is StablecoinData => e !== null);

  if (validated.length === 0) {
    return null;
  }

  if (validated.length < rawArray.length) {
    console.warn(`[stablecoins-cache] Filtered ${rawArray.length - validated.length} malformed entries`);
  }

  return validated;
}

function normalizePayload(
  parsed: unknown,
  allowLegacyArray: boolean,
):
  | { kind: "ok"; payload: StablecoinsCachePayload }
  | { kind: "degraded"; reason: "legacy-array-payload"; payload: StablecoinsCachePayload }
  | { kind: "error"; reason: StablecoinsCacheFailureReason } {
  if (Array.isArray(parsed)) {
    if (!allowLegacyArray) {
      return { kind: "error", reason: "legacy-array-not-allowed" };
    }
    const validated = validateAndFilterArray(parsed);
    if (validated === null) {
      return { kind: "error", reason: "missing-pegged-assets" };
    }
    return {
      kind: "degraded",
      reason: "legacy-array-payload",
      payload: { peggedAssets: validated },
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { kind: "error", reason: "invalid-payload-shape" };
  }

  const obj = parsed as { peggedAssets?: unknown; fxFallbackRates?: unknown };
  if (!Array.isArray(obj.peggedAssets)) {
    return { kind: "error", reason: "missing-pegged-assets" };
  }

  const validated = validateAndFilterArray(obj.peggedAssets);
  if (validated === null) {
    return { kind: "error", reason: "missing-pegged-assets" };
  }

  return {
    kind: "ok",
    payload: {
      peggedAssets: validated,
      fxFallbackRates: toFxFallbackRates(obj.fxFallbackRates),
    },
  };
}

function toFailure(
  _mode: "strict" | "lenient",
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
  const allowLegacyArray = options.allowLegacyArray ?? true;
  const cached = await getCache(db, "stablecoins");

  if (!cached) {
    return toFailure(mode, "missing-cache", null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cached.value);
  } catch {
    return toFailure(mode, "json-parse-failed", cached.updatedAt);
  }

  const normalized = normalizePayload(parsed, allowLegacyArray);
  if (normalized.kind === "error") {
    return toFailure(mode, normalized.reason, cached.updatedAt);
  }

  if (normalized.kind === "degraded") {
    return {
      kind: "degraded",
      reason: normalized.reason,
      payload: normalized.payload,
      updatedAt: cached.updatedAt,
    };
  }

  return { kind: "ok", payload: normalized.payload, updatedAt: cached.updatedAt };
}
