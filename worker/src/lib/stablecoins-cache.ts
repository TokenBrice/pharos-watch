import { getCache } from "./db";
import type { StablecoinData } from "../../../src/lib/types";

export interface StablecoinsCachePayload {
  peggedAssets: StablecoinData[];
  fxFallbackRates?: Record<string, number>;
}

interface StablecoinsCacheLoadBase {
  payload: StablecoinsCachePayload;
  updatedAt: number | null;
}

export type StablecoinsCacheLoadResult =
  | (StablecoinsCacheLoadBase & { ok: true; warningReason?: string })
  | (StablecoinsCacheLoadBase & { ok: false; reason: string });

export interface LoadStablecoinsCacheOptions {
  mode?: "strict" | "lenient";
  allowLegacyArray?: boolean;
}

const EMPTY_PAYLOAD: StablecoinsCachePayload = { peggedAssets: [] };

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
): { ok: true; payload: StablecoinsCachePayload } | { ok: false; reason: string } {
  if (Array.isArray(parsed)) {
    if (!allowLegacyArray) {
      return { ok: false, reason: "legacy-array-not-allowed" };
    }
    return { ok: true, payload: { peggedAssets: parsed as StablecoinData[] } };
  }

  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "invalid-payload-shape" };
  }

  const obj = parsed as { peggedAssets?: unknown; fxFallbackRates?: unknown };
  if (!Array.isArray(obj.peggedAssets)) {
    return { ok: false, reason: "missing-pegged-assets" };
  }

  return {
    ok: true,
    payload: {
      peggedAssets: obj.peggedAssets as StablecoinData[],
      fxFallbackRates: toFxFallbackRates(obj.fxFallbackRates),
    },
  };
}

export async function loadStablecoinsCache(
  db: D1Database,
  options: LoadStablecoinsCacheOptions = {},
): Promise<StablecoinsCacheLoadResult> {
  const mode = options.mode ?? "strict";
  const allowLegacyArray = options.allowLegacyArray ?? true;
  const cached = await getCache(db, "stablecoins");

  if (!cached) {
    if (mode === "strict") {
      return { ok: false, reason: "missing-cache", payload: EMPTY_PAYLOAD, updatedAt: null };
    }
    return {
      ok: true,
      warningReason: "missing-cache",
      payload: EMPTY_PAYLOAD,
      updatedAt: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cached.value);
  } catch {
    if (mode === "strict") {
      return { ok: false, reason: "json-parse-failed", payload: EMPTY_PAYLOAD, updatedAt: cached.updatedAt };
    }
    return {
      ok: true,
      warningReason: "json-parse-failed",
      payload: EMPTY_PAYLOAD,
      updatedAt: cached.updatedAt,
    };
  }

  const normalized = normalizePayload(parsed, allowLegacyArray);
  if (!normalized.ok) {
    if (mode === "strict") {
      return { ok: false, reason: normalized.reason, payload: EMPTY_PAYLOAD, updatedAt: cached.updatedAt };
    }
    return {
      ok: true,
      warningReason: normalized.reason,
      payload: EMPTY_PAYLOAD,
      updatedAt: cached.updatedAt,
    };
  }

  return { ok: true, payload: normalized.payload, updatedAt: cached.updatedAt };
}
