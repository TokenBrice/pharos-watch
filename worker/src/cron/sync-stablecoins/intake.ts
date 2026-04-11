import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import { fetchWithRetry } from "../../lib/fetch-retry";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { cancelResponseBodyQuietly } from "../../lib/response-body";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { upsertDiscoveryCandidates } from "../discovery-scan";
import type { PeggedAsset } from "./enrich-prices";
import {
  applyTrackedAssetOverrides,
  type CanonicalDeduplicationResult,
  dedupeCanonicalAssets,
  filterStructurallyValidAssets,
  normalizeChainCirculating,
} from "./phase-helpers";
import {
  fetchCoinGeckoMarketData,
  fetchSupplementalTrackedTokens,
  type CoinGeckoMcapData,
} from "./supplemental-assets";
import { reconcileTrackedSupplyGaps } from "./supply-gap-reconciliation";
import {
  hydrateGeckoIdAliases,
  loadPreviousStablecoinsById,
  mergeSupplementalLastKnownGood,
  type CronResult,
} from "./shared";

interface StablecoinsIntakeMainResult {
  kind: "main";
  assets: PeggedAsset[];
  rawAssetCount: number;
  droppedMalformedAssets: number;
  canonicalDeduplication: CanonicalDeduplicationResult;
  fxFallbackRates?: Record<string, number>;
  previousAssetsById: Map<string, PeggedAsset>;
  cgData: CoinGeckoMcapData;
}

interface StablecoinsIntakeFallbackResult {
  kind: "fallback";
  result: CronResult;
  errorMessage: string;
}

export type StablecoinsIntakeResult =
  | StablecoinsIntakeMainResult
  | StablecoinsIntakeFallbackResult;

const DEFILLAMA_STABLECOINS_URL = `${DEFILLAMA_BASE}/stablecoins?includePrices=true`;
const DL_PARSE_MAX_ATTEMPTS = 3;
const DL_PARSE_RETRY_BASE_DELAY_MS = 500;

type DefillamaStablecoinsPayload = {
  peggedAssets: PeggedAsset[];
  fxFallbackRates?: Record<string, number>;
};

interface DefillamaFetchResult {
  payload: DefillamaStablecoinsPayload | null;
  attempts: number;
  lastError: "fetch-failed" | "parse-failed" | null;
  lastHttpStatus: number | null;
}

async function fetchDefillamaStablecoinsPayload(
  signal: AbortSignal | undefined,
): Promise<DefillamaFetchResult> {
  let lastError: DefillamaFetchResult["lastError"] = null;
  let lastHttpStatus: number | null = null;
  let attempts = 0;
  for (let attempt = 0; attempt < DL_PARSE_MAX_ATTEMPTS; attempt++) {
    throwIfAborted(signal);
    attempts = attempt + 1;
    const res = await fetchWithRetry(
      DEFILLAMA_STABLECOINS_URL,
      signal ? { signal } : undefined,
    );
    if (!res?.ok) {
      lastError = "fetch-failed";
      lastHttpStatus = res?.status ?? null;
      break;
    }
    try {
      const payload = (await res.json()) as DefillamaStablecoinsPayload;
      return {
        payload,
        attempts,
        lastError: null,
        lastHttpStatus: res.status,
      };
    } catch (parseErr) {
      lastError = "parse-failed";
      lastHttpStatus = res.status;
      console.warn(
        `[sync-stablecoins] DL response body parse failed on attempt ${attempts}/${DL_PARSE_MAX_ATTEMPTS}:`,
        parseErr,
      );
      // Release the partially-consumed response before retrying so we don't
      // hold a socket against the 6-connection pool during the backoff.
      await cancelResponseBodyQuietly(res);
      if (attempts < DL_PARSE_MAX_ATTEMPTS) {
        await sleepWithSignal(DL_PARSE_RETRY_BASE_DELAY_MS * attempts, signal);
      }
    }
  }
  return {
    payload: null,
    attempts,
    lastError,
    lastHttpStatus,
  };
}

export async function loadStablecoinsIntake(
  input: {
    db: D1Database;
    signal?: AbortSignal;
    syncStartSec: number;
    fxFallbackRates?: Record<string, number>;
    coingeckoApiKey?: string | null;
    chainRpcs?: Map<string, ChainRpcConfig>;
    fallbackToCoingecko: (cgData: CoinGeckoMcapData) => Promise<CronResult>;
  },
): Promise<StablecoinsIntakeResult> {
  const previousAssetsById = await loadPreviousStablecoinsById(input.db);
  const cgData = await fetchCoinGeckoMarketData(input.db, input.signal, input.coingeckoApiKey);

  const dlAllowed = await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.DL_STABLECOINS);
  const supplementalTokensPromise = fetchSupplementalTrackedTokens(
    cgData,
    input.signal,
    input.coingeckoApiKey,
    input.chainRpcs,
    input.fxFallbackRates,
  );

  if (!dlAllowed) {
    console.warn("[sync-stablecoins] DL stablecoins circuit open — using CG supply fallback");
    await supplementalTokensPromise;
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    };
  }

  const [dlFetchResult, supplementalTokens] = await Promise.all([
    fetchDefillamaStablecoinsPayload(input.signal),
    supplementalTokensPromise,
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  if (!dlFetchResult.payload) {
    if (dlFetchResult.lastError === "parse-failed") {
      console.error(
        `[sync-stablecoins] DL response body parse failed after ${dlFetchResult.attempts} attempts (last HTTP status=${dlFetchResult.lastHttpStatus ?? "unknown"})`,
      );
    } else {
      console.error(
        `[sync-stablecoins] DefiLlama API error after ${dlFetchResult.attempts} attempt(s) (last HTTP status=${dlFetchResult.lastHttpStatus ?? "no response"})`,
      );
    }
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage:
        dlFetchResult.lastError === "parse-failed"
          ? "DefiLlama response body parse failed"
          : "DefiLlama stablecoins API failed and CoinGecko fallback was insufficient",
    };
  }

  const llamaData = dlFetchResult.payload;
  const rawAssetCount = llamaData.peggedAssets?.length ?? 0;

  if (llamaData.peggedAssets === undefined) {
    console.warn("[sync] DefiLlama response missing peggedAssets field — possible API contract change");
  }
  if (!llamaData.peggedAssets || llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Unexpected asset count (${llamaData.peggedAssets?.length}), need ${MIN_VALID_ASSET_COUNT}+, skipping cache write`);
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload was structurally invalid (asset count=${llamaData.peggedAssets?.length ?? 0}) and fallback failed`,
    };
  }

  const { validAssets, droppedMalformedAssets } = filterStructurallyValidAssets(llamaData.peggedAssets);
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(`[sync-stablecoins] Only ${validAssets.length} valid assets (need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`);
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload had too many malformed assets (valid=${validAssets.length}) and fallback failed`,
    };
  }
  if (validAssets.length < llamaData.peggedAssets.length) {
    console.warn(`[sync-stablecoins] Dropped ${llamaData.peggedAssets.length - validAssets.length} malformed assets`);
    llamaData.peggedAssets = validAssets;
  }

  hydrateGeckoIdAliases(llamaData.peggedAssets);
  normalizeChainCirculating(llamaData.peggedAssets);

  const dlResiduals = llamaData.peggedAssets
    .filter((a) => !REGISTRY_BY_LLAMA_ID.has(String(a.id)))
    .filter((a) => {
      const circ = a.circulating;
      if (!circ || typeof circ !== "object") return false;
      const total = Object.values(circ).reduce((sum: number, v: unknown) => sum + (typeof v === "number" ? v : 0), 0);
      return total >= 5_000_000;
    })
    .map((a) => ({
      llamaId: Number(a.id),
      name: a.name as string,
      symbol: a.symbol as string,
      marketCap: Object.values(a.circulating ?? {}).reduce((sum: number, v: unknown) => sum + (typeof v === "number" ? v : 0), 0),
      source: "defillama" as const,
    }));

  if (dlResiduals.length > 0) {
    try {
      await upsertDiscoveryCandidates(input.db, dlResiduals);
      console.log(`[discovery] DL residuals: ${dlResiduals.length} untracked coins above $5M`);
    } catch (err) {
      console.warn("[discovery] DL residuals upsert failed:", err);
    }
  }

  for (const asset of llamaData.peggedAssets) {
    const mapped = REGISTRY_BY_LLAMA_ID.get(String(asset.id));
    if (mapped) {
      asset.id = mapped.id;
    }
  }

  const canonicalDeduplication = dedupeCanonicalAssets(llamaData.peggedAssets);
  if (canonicalDeduplication.duplicateRows > 0) {
    console.warn(
      `[sync-stablecoins] Deduped ${canonicalDeduplication.duplicateRows} canonical duplicate row(s): ` +
      canonicalDeduplication.affectedIds.join(", "),
    );
    llamaData.peggedAssets = canonicalDeduplication.dedupedAssets;
  }
  if (llamaData.peggedAssets.length < MIN_VALID_ASSET_COUNT) {
    console.error(
      `[sync-stablecoins] Canonical dedupe reduced asset count to ${llamaData.peggedAssets.length} ` +
      `(need ${MIN_VALID_ASSET_COUNT}+), skipping cache write`,
    );
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload collapsed to ${llamaData.peggedAssets.length} unique canonical IDs and fallback failed`,
    };
  }

  const supplementalResolution = mergeSupplementalLastKnownGood(
    [...goldTokens, ...silverTokens, ...fiatCgTokens],
    previousAssetsById,
    new Set(llamaData.peggedAssets.map((asset) => String(asset.id))),
  );
  if (supplementalResolution.assets.length > 0) {
    llamaData.peggedAssets = [...llamaData.peggedAssets, ...supplementalResolution.assets];
  }
  if (supplementalResolution.restoredCount > 0 || supplementalResolution.skippedDuplicates > 0) {
    console.log(
      `[sync-stablecoins] Supplemental resolution: restored=${supplementalResolution.restoredCount}, ` +
      `skippedDuplicates=${supplementalResolution.skippedDuplicates}`,
    );
  }

  applyTrackedAssetOverrides(llamaData.peggedAssets);

  const supplyGapReconciliation = await reconcileTrackedSupplyGaps(
    llamaData.peggedAssets,
    input.signal,
    input.coingeckoApiKey,
  );
  if (supplyGapReconciliation.reconciledCount > 0) {
    console.warn(
      `[sync-stablecoins] Reconciled ${supplyGapReconciliation.reconciledCount} tracked supply gap(s) from history repair: ` +
      supplyGapReconciliation.reconciledIds.join(", "),
    );
  }

  return {
    kind: "main",
    assets: llamaData.peggedAssets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    fxFallbackRates: llamaData.fxFallbackRates,
    previousAssetsById,
    cgData,
  };
}
