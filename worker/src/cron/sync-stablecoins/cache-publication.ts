import { FROZEN_IDS, FROZEN_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { validatePayloadWithSchema } from "../../lib/api-utils";
import { writeResponseReadyCache } from "../../lib/api-cache-read";
import { RESPONSE_READY_CACHE_SCHEMA_IDS } from "../../lib/response-ready-cache-contracts";
import { savePriceCache, setCacheIfNewer, type PriceCacheWriteEntry } from "../../lib/db-cache";
import type { PeggedAsset } from "./enrich-prices";
import {
  getStablecoinsCacheAgeSec,
  normalizeStablecoinsPayload,
  StablecoinListResponseSchema,
  summarizeValidationIssues,
  writeInvalidStablecoinsDiagnostic,
  type CronResult,
  type StablecoinsPayload,
} from "./shared";

export interface CacheValidationResult {
  /** Whether the schema validation succeeded and the cache was written. */
  written: boolean;
  /** Whether the write was skipped because a newer canonical cache already exists. */
  skippedBecauseNewer: boolean;
  cacheKey: string;
  syncStartSec: number;
  /** If validation failed, the degraded CronResult to return. */
  blockedResult?: CronResult;
  /** Non-fatal companion-cache write failure for response-ready optimization. */
  responseReadyCacheError?: string | null;
}

export interface ValidateAndCacheInput {
  assets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
  db: D1Database;
  syncStartSec: number;
  signal?: AbortSignal;
  /** "main" or "fallback" - controls log messages */
  validationContext: "main" | "fallback";
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  abortResult: (signal: AbortSignal | undefined, stage: string) => CronResult;
}

/**
 * Normalizes the payload, validates against the schema, and writes to the
 * stablecoins cache. Returns the CAS outcome on valid payloads or
 * `{ written: false, blockedResult }` on validation failure.
 */
export async function validateAndWriteStablecoinsCache(
  input: ValidateAndCacheInput,
  buildBlockedResult: (stablecoinsCacheAgeSec: number | null) => CronResult,
): Promise<CacheValidationResult | CronResult> {
  const { assets, fxFallbackRates, db, syncStartSec, signal, validationContext, returnIfAborted } =
    input;

  // Tag frozen coins so /api/stablecoins exposes `frozen` and `frozenAt` per-coin.
  // Runs after intake's mergeFrozenSnapshots so injected rows also get tagged here.
  for (const asset of assets) {
    const frozenMeta = FROZEN_META_BY_ID.get(asset.id);
    if (FROZEN_IDS.has(asset.id)) {
      asset.frozen = true;
      if (frozenMeta?.frozenAt != null) {
        asset.frozenAt = frozenMeta.frozenAt;
      } else {
        delete asset.frozenAt;
      }
      continue;
    }
    delete asset.frozen;
    delete asset.frozenAt;
  }

  const llamaData: StablecoinsPayload = { peggedAssets: assets, fxFallbackRates };
  const normalizedPayload = normalizeStablecoinsPayload(llamaData);
  const validationLabel =
    validationContext === "fallback" ? "sync-stablecoins:stablecoins:fallback" : "sync-stablecoins:stablecoins";
  const validation = validatePayloadWithSchema(StablecoinListResponseSchema, normalizedPayload, validationLabel);

  if (!validation.ok) {
    const issueSummary = summarizeValidationIssues(validation.issues);
    const stablecoinsCacheAgeSec = await getStablecoinsCacheAgeSec(db);
    console.error(
      `[sync-stablecoins] Schema validation failed${validationContext === "fallback" ? " in CG fallback" : ""}; blocking stablecoins cache write:`,
      issueSummary,
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      validationContext,
      normalizedPayload,
      validation.issues,
      stablecoinsCacheAgeSec,
    );
    return {
      written: false,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      syncStartSec,
      blockedResult: buildBlockedResult(stablecoinsCacheAgeSec),
    };
  }

  const cacheWriteAbort = returnIfAborted(
    signal,
    validationContext === "fallback" ? "fallback-cache-write" : "persist-main-cache",
  );
  if (cacheWriteAbort) return cacheWriteAbort;
  const stablecoinsCacheBody = JSON.stringify(validation.data);
  const cacheResult = await setCacheIfNewer(db, "stablecoins", stablecoinsCacheBody, syncStartSec);
  let responseReadyCacheError: string | null = null;
  if (cacheResult.written) {
    try {
      await writeResponseReadyCache(db, "stablecoins", stablecoinsCacheBody, syncStartSec, {
        schemaId: RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins,
      });
    } catch (error) {
      responseReadyCacheError = error instanceof Error ? error.name : "UnknownError";
    }
  }
  if (cacheResult.written) {
    console.log(
      `[sync-stablecoins] ${validationContext === "fallback" ? "CG fallback: cached" : "Cached"} ${assets.length} assets`,
    );
  } else {
    console.log(
      `[sync-stablecoins] Skipped stablecoins cache write; newer canonical cache already exists ` +
        `(syncStartSec=${syncStartSec})`,
    );
  }

  return {
    ...cacheResult,
    cacheKey: "stablecoins",
    syncStartSec,
    responseReadyCacheError,
  };
}

export async function commitReplayPriceCache(input: {
  db: D1Database;
  entries: PriceCacheWriteEntry[];
  signal?: AbortSignal;
  returnIfAborted: (signal: AbortSignal | undefined, stage: string) => CronResult | null;
  stagePrefix?: string;
}): Promise<CronResult | null> {
  if (input.entries.length === 0) return null;
  const stage = `${input.stagePrefix ?? ""}save-price-cache`;
  const priceCacheWriteAbort = input.returnIfAborted(input.signal, stage);
  if (priceCacheWriteAbort) return priceCacheWriteAbort;
  await savePriceCache(input.db, input.entries);
  return null;
}
