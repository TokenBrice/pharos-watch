import { getCache } from "./db";
import type { StablecoinData } from "@shared/types";

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
    return {
      kind: "degraded",
      reason: "legacy-array-payload",
      payload: { peggedAssets: parsed as StablecoinData[] },
    };
  }

  if (!parsed || typeof parsed !== "object") {
    return { kind: "error", reason: "invalid-payload-shape" };
  }

  const obj = parsed as { peggedAssets?: unknown; fxFallbackRates?: unknown };
  if (!Array.isArray(obj.peggedAssets)) {
    return { kind: "error", reason: "missing-pegged-assets" };
  }

  return {
    kind: "ok",
    payload: {
      peggedAssets: obj.peggedAssets as StablecoinData[],
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
