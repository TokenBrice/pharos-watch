import { logWorkerEventArgs } from "../../lib/structured-log";
import { FROZEN_IDS, FROZEN_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { projectLegacyChainCirculatingWire } from "@shared/lib/chains/circulating";
import { formatSchemaLikeIssues } from "@shared/lib/schema-like";
import { StablecoinDataSchema, type StablecoinData } from "@shared/types/market";
import { MIN_VALID_ASSET_COUNT } from "../../lib/constants";
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

/** One post-enrichment row withheld from publication because it failed the published row schema. */
export interface PublicationQuarantinedAsset {
  id: string | null;
  issues: string;
}

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
  /** Rows quarantined per asset (DEC-03) and removed from `input.assets`; peers still published. */
  quarantinedAssets: PublicationQuarantinedAsset[];
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

type PublicationAdmission =
  | { ok: true; payload: { peggedAssets: StablecoinData[]; fxFallbackRates?: Record<string, number> }; quarantined: PublicationQuarantinedAsset[]; quarantinedIndexes: Set<number> }
  | { ok: false; issues: string };

/**
 * DEC-03 publication boundary. Each normalized row is validated on its own against the published row
 * schema; a schema-invalid row is quarantined with its issues while valid peers publish. The whole list is
 * held only for a global failure: an invalid envelope (FX map), a duplicate published id (identity), or a
 * quarantine that leaves fewer admitted rows than the `MIN_VALID_ASSET_COUNT` intake floor (the cohort-wide
 * schema drift that would otherwise publish a near-empty list). Intake already enforced that floor, so a
 * cohort without quarantined rows is never re-held here.
 */
function admitPublishableAssets(payload: StablecoinsPayload): PublicationAdmission {
  const envelope = StablecoinListResponseSchema.safeParse({ peggedAssets: [], fxFallbackRates: payload.fxFallbackRates });
  if (!envelope.success) return { ok: false, issues: `envelope: ${formatSchemaLikeIssues(envelope.error.issues)}` };

  const admitted: StablecoinData[] = [];
  const quarantined: PublicationQuarantinedAsset[] = [];
  const quarantinedIndexes = new Set<number>();
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  payload.peggedAssets.forEach((row, index) => {
    const parsed = StablecoinDataSchema.safeParse(row);
    if (!parsed.success) {
      quarantinedIndexes.add(index);
      quarantined.push({
        id: typeof row?.id === "string" ? row.id : null,
        issues: formatSchemaLikeIssues(parsed.error.issues),
      });
      return;
    }
    if (seenIds.has(parsed.data.id)) duplicateIds.add(parsed.data.id);
    seenIds.add(parsed.data.id);
    admitted.push(parsed.data);
  });

  if (duplicateIds.size > 0) {
    return { ok: false, issues: `identity: duplicate published ids ${[...duplicateIds].join(", ")}` };
  }
  if (quarantined.length > 0 && admitted.length < MIN_VALID_ASSET_COUNT) {
    const detail = quarantined.slice(0, 5).map((row) => `${row.id ?? "<no id>"}: ${row.issues}`).join("; ");
    return {
      ok: false,
      issues: `floor: ${admitted.length} valid rows < ${MIN_VALID_ASSET_COUNT}${detail ? `; ${detail}` : ""}`,
    };
  }
  return {
    ok: true,
    payload: { peggedAssets: admitted, ...(envelope.data.fxFallbackRates ? { fxFallbackRates: envelope.data.fxFallbackRates } : {}) },
    quarantined,
    quarantinedIndexes,
  };
}

/**
 * Normalizes the payload, admits rows per asset, and writes to the stablecoins cache. Returns the CAS
 * outcome on a publishable cohort (quarantined rows removed from `input.assets` so later stages see the
 * published cohort) or `{ written: false, blockedResult }` on a global validation failure.
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
  const admission = admitPublishableAssets(normalizedPayload);

  if (!admission.ok) {
    const issueSummary = summarizeValidationIssues(admission.issues);
    const stablecoinsCacheAgeSec = await getStablecoinsCacheAgeSec(db);
    logWorkerEventArgs("handler", "error",
      `[sync-stablecoins] Schema validation failed${validationContext === "fallback" ? " in CG fallback" : ""}; blocking stablecoins cache write:`,
      issueSummary,
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      validationContext,
      normalizedPayload,
      admission.issues,
      stablecoinsCacheAgeSec,
    );
    return {
      written: false,
      skippedBecauseNewer: false,
      cacheKey: "stablecoins",
      syncStartSec,
      blockedResult: buildBlockedResult(stablecoinsCacheAgeSec),
      quarantinedAssets: [],
    };
  }

  if (admission.quarantined.length > 0) {
    const issues = admission.quarantined.map((row) => `${row.id ?? "<no id>"}: ${row.issues}`).join("; ");
    logWorkerEventArgs("handler", "warn",
      `[sync-stablecoins] Quarantined ${admission.quarantined.length} schema-invalid asset(s)${validationContext === "fallback" ? " in CG fallback" : ""}; publishing valid peers:`,
      summarizeValidationIssues(issues),
    );
    await writeInvalidStablecoinsDiagnostic(
      db,
      syncStartSec,
      validationContext,
      { peggedAssets: normalizedPayload.peggedAssets.filter((_, index) => admission.quarantinedIndexes.has(index)) },
      issues,
      null,
    );
    // normalizeStablecoinsPayload maps rows 1:1, so indexes address the caller's asset rows.
    const kept = assets.filter((_, index) => !admission.quarantinedIndexes.has(index));
    assets.splice(0, assets.length, ...kept);
  }

  const cacheWriteAbort = returnIfAborted(
    signal,
    validationContext === "fallback" ? "fallback-cache-write" : "persist-main-cache",
  );
  if (cacheWriteAbort) return cacheWriteAbort;
  const stablecoinsCacheBody = JSON.stringify(admission.payload);
  const cacheResult = await setCacheIfNewer(db, "stablecoins", stablecoinsCacheBody, syncStartSec);
  let responseReadyCacheError: string | null = null;
  if (cacheResult.written) {
    try {
      // RELEASE A: the canonical cache keeps unavailable chain observations as `null` for internal
      // readers; the public companion body keeps the legacy wire until the Release B activation.
      const publicPayload = projectLegacyChainCirculatingWire(admission.payload);
      const publicBody = publicPayload === admission.payload ? stablecoinsCacheBody : JSON.stringify(publicPayload);
      await writeResponseReadyCache(db, "stablecoins", publicBody, syncStartSec, {
        schemaId: RESPONSE_READY_CACHE_SCHEMA_IDS.stablecoins,
      });
    } catch (error) {
      responseReadyCacheError = error instanceof Error ? error.name : "UnknownError";
    }
  }
  if (cacheResult.written) {
    logWorkerEventArgs("handler", "info",
      `[sync-stablecoins] ${validationContext === "fallback" ? "CG fallback: cached" : "Cached"} ${assets.length} assets`,
    );
  } else {
    logWorkerEventArgs("handler", "info",
      `[sync-stablecoins] Skipped stablecoins cache write; newer canonical cache already exists ` +
        `(syncStartSec=${syncStartSec})`,
    );
  }

  return {
    ...cacheResult,
    cacheKey: "stablecoins",
    syncStartSec,
    responseReadyCacheError,
    quarantinedAssets: admission.quarantined,
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
