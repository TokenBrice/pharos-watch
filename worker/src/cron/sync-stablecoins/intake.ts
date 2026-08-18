import { REGISTRY_BY_LLAMA_ID } from "@shared/lib/stablecoin-id-registry";
import { FROZEN_SNAPSHOTS } from "@shared/lib/stablecoins/frozen-snapshots";
import type { FrozenSnapshot } from "@shared/lib/stablecoins/frozen-snapshots";
import { fetchTextWithRetry } from "../../lib/fetch-retry";
import { sleepWithSignal, throwIfAborted } from "../../lib/abort";
import { CIRCUIT_SOURCE, DEFILLAMA_BASE, MIN_VALID_ASSET_COUNT } from "../../lib/constants";
import { shouldAttemptFetch, recordOutcome } from "../../lib/circuit-breaker";
import type { ChainRpcConfig } from "../../lib/chain-registry";
import { logWorkerEvent } from "../../lib/structured-log";
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
import {
  reconcileTrackedSupplyGaps,
  type SupplyGapReconciliationResult,
} from "./supply-gap-reconciliation";
import {
  hydrateGeckoIdAliases,
  loadPreviousStablecoinsById,
  mergeSupplementalLastKnownGood,
  replaceZeroSupplyPrimaryAssets,
  restoreMissingTrackedAssets,
  type CronResult,
  type PreviousStablecoinsCacheState,
  type TrackedCoverageRestoreResult,
} from "./shared";

interface StablecoinsIntakeMainResult {
  kind: "main";
  assets: PeggedAsset[];
  rawAssetCount: number;
  droppedMalformedAssets: number;
  canonicalDeduplication: CanonicalDeduplicationResult;
  fxFallbackRates?: Record<string, number>;
  previousAssetsById: Map<string, PeggedAsset>;
  previousCacheState: PreviousStablecoinsCacheState;
  cgData: CoinGeckoMcapData;
  supplyGapReconciliation: SupplyGapReconciliationResult;
  trackedCoverage: TrackedCoverageRestoreResult;
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
// Transport-level retries run on the first attempt only. The parse-retry loop
// below re-fetches on a corrupt body, so leaving `fetchTextWithRetry` at its
// 2-retry default on every pass allowed 3 x 3 = 9 upstream requests in the worst
// case, against the ADR-4 per-run request budget. Capped at 3 + 1 + 1 = 5.
const DL_TRANSPORT_RETRIES_FIRST_ATTEMPT = 2;

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
    const result = await fetchTextWithRetry(
      DEFILLAMA_STABLECOINS_URL,
      signal ? { signal } : undefined,
      attempt === 0 ? DL_TRANSPORT_RETRIES_FIRST_ATTEMPT : 0,
      { returnFinalResponse: true },
    );
    if (!result?.response.ok) {
      lastError = "fetch-failed";
      lastHttpStatus = result?.response.status ?? null;
      break;
    }
    try {
      const payload = JSON.parse(result.body) as DefillamaStablecoinsPayload;
      return {
        payload,
        attempts,
        lastError: null,
        lastHttpStatus: result.response.status,
      };
    } catch (parseErr) {
      lastError = "parse-failed";
      lastHttpStatus = result.response.status;
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoins",
        level: "warn",
        event: "defillama-response-parse-retry",
        message: "DL response body parse failed; retrying",
        metadata: { attempt: attempts, maxAttempts: DL_PARSE_MAX_ATTEMPTS },
        error: parseErr,
      });
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

/**
 * Append captured frozen-coin rows for any canonical id absent from the
 * upstream payload. This is intentionally run before structural validation,
 * chain-circulating normalization, canonical-id mapping, and dedupe so frozen
 * snapshots pass through the same intake safeguards as live DefiLlama rows.
 * Upstream rows always win — if DefiLlama still serves the asset, that's the
 * authoritative copy. Returns the input array unchanged when there is nothing
 * to inject (so existing identity tests pass).
 */
export function mergeFrozenSnapshots(
  upstream: PeggedAsset[],
  snapshots: FrozenSnapshot[],
): PeggedAsset[] {
  if (snapshots.length === 0) {
    return upstream;
  }
  const upstreamIds = new Set(
    upstream.flatMap((a) => {
      const id = String((a as { id?: unknown }).id ?? "");
      const mapped = REGISTRY_BY_LLAMA_ID.get(id)?.id;
      return mapped && mapped !== id ? [id, mapped] : [id];
    }),
  );
  const additions: PeggedAsset[] = [];
  for (const snapshot of snapshots) {
    if (upstreamIds.has(snapshot.id)) {
      continue;
    }
    additions.push(snapshot.peggedAssetRow as unknown as PeggedAsset);
    upstreamIds.add(snapshot.id);
  }
  if (additions.length === 0) {
    return upstream;
  }
  return [...upstream, ...additions];
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
  const { previousAssetsById, cacheState: previousCacheState } = await loadPreviousStablecoinsById(input.db);
  const cgData = await fetchCoinGeckoMarketData(input.db, input.signal, input.coingeckoApiKey);

  const dlAllowed = await shouldAttemptFetch(input.db, CIRCUIT_SOURCE.DL_STABLECOINS);
  if (!dlAllowed) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "defillama-circuit-open",
      message: "DL stablecoins circuit open; using CG supply fallback",
    });
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: "DefiLlama stablecoins circuit open and CoinGecko fallback was insufficient",
    };
  }

  const supplementalTokensPromise = fetchSupplementalTrackedTokens(
    cgData,
    input.signal,
    input.coingeckoApiKey,
    input.chainRpcs,
    input.fxFallbackRates,
    input.db,
  );

  const [dlFetchResult, supplementalTokens] = await Promise.all([
    fetchDefillamaStablecoinsPayload(input.signal),
    supplementalTokensPromise,
  ]);
  const { goldTokens, silverTokens, fiatCgTokens } = supplementalTokens;

  if (!dlFetchResult.payload) {
    if (dlFetchResult.lastError === "parse-failed") {
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoins",
        event: "defillama-response-parse-failed",
        message: "DL response body parse failed after retries",
        metadata: {
          attempts: dlFetchResult.attempts,
          lastHttpStatus: dlFetchResult.lastHttpStatus ?? "unknown",
        },
      });
    } else {
      logWorkerEvent({
        scope: "lib",
        job: "sync-stablecoins",
        event: "defillama-fetch-failed",
        message: "DefiLlama API error after retries",
        metadata: {
          attempts: dlFetchResult.attempts,
          lastHttpStatus: dlFetchResult.lastHttpStatus ?? "no response",
        },
      });
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

  // Capture only the two consumed payload fields so the parsed payload wrapper
  // (and its raw unfiltered asset array) can be collected once the intake
  // pipeline replaces `assets` below, instead of staying pinned until return.
  const { peggedAssets: rawPeggedAssets, fxFallbackRates: dlFxFallbackRates } = dlFetchResult.payload;
  const rawAssetCount = rawPeggedAssets?.length ?? 0;

  if (rawPeggedAssets === undefined) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "defillama-pegged-assets-missing",
      message: "DefiLlama response missing peggedAssets field; possible API contract change",
    });
  }
  if (!rawPeggedAssets || rawPeggedAssets.length < MIN_VALID_ASSET_COUNT) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      event: "unexpected-asset-count",
      message: "Unexpected asset count; skipping cache write",
      metadata: { assetCount: rawPeggedAssets?.length, minimumAssetCount: MIN_VALID_ASSET_COUNT },
    });
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload was structurally invalid (asset count=${rawPeggedAssets?.length ?? 0}) and fallback failed`,
    };
  }

  // Run the transformation pipeline on a local variable. `rawPeggedAssets` is
  // guaranteed defined and valid by the guards above; the steps below reassign
  // `assets` rather than mutating the raw array, and nothing references the raw
  // array (or the payload wrapper) past this point, so both become collectible
  // as soon as validation/dedupe produce replacement arrays.
  let assets = mergeFrozenSnapshots(rawPeggedAssets, FROZEN_SNAPSHOTS);
  const injectedFrozenSnapshots = assets.length - rawAssetCount;
  if (injectedFrozenSnapshots > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "info",
      event: "frozen-snapshots-injected",
      message: "Injected frozen-snapshot rows",
      metadata: { injectedFrozenSnapshots },
    });
  }

  const { validAssets, droppedMalformedAssets } = filterStructurallyValidAssets(assets);
  if (validAssets.length < MIN_VALID_ASSET_COUNT) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      event: "insufficient-valid-assets",
      message: "Too few valid assets; skipping cache write",
      metadata: { validAssetCount: validAssets.length, minimumAssetCount: MIN_VALID_ASSET_COUNT },
    });
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload had too many malformed assets (valid=${validAssets.length}) and fallback failed`,
    };
  }
  if (validAssets.length < assets.length) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "malformed-assets-dropped",
      message: "Dropped malformed assets",
      metadata: { droppedAssetCount: assets.length - validAssets.length },
    });
    assets = validAssets;
  }

  hydrateGeckoIdAliases(assets);
  normalizeChainCirculating(assets);

  for (const asset of assets) {
    const mapped = REGISTRY_BY_LLAMA_ID.get(String(asset.id));
    if (mapped) {
      asset.id = mapped.id;
    }
  }

  const canonicalDeduplication = dedupeCanonicalAssets(assets);
  if (canonicalDeduplication.duplicateRows > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "canonical-assets-deduped",
      message: "Deduped canonical duplicate rows",
      metadata: {
        duplicateRows: canonicalDeduplication.duplicateRows,
        affectedIds: canonicalDeduplication.affectedIds,
      },
    });
    assets = canonicalDeduplication.dedupedAssets;
  }
  if (assets.length < MIN_VALID_ASSET_COUNT) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      event: "insufficient-canonical-assets",
      message: "Canonical dedupe reduced asset count below the minimum; skipping cache write",
      metadata: { assetCount: assets.length, minimumAssetCount: MIN_VALID_ASSET_COUNT },
    });
    await recordOutcome(input.db, CIRCUIT_SOURCE.DL_STABLECOINS, false);
    return {
      kind: "fallback",
      result: await input.fallbackToCoingecko(cgData),
      errorMessage: `DefiLlama payload collapsed to ${assets.length} unique canonical IDs and fallback failed`,
    };
  }

  const supplementalAssets = [...goldTokens, ...silverTokens, ...fiatCgTokens];
  const primaryReplacement = replaceZeroSupplyPrimaryAssets(assets, supplementalAssets);
  assets = primaryReplacement.assets;
  if (primaryReplacement.replacedIds.length > 0) {
    logWorkerEvent({
      scope: "lib",
      level: "warn",
      event: "zero-supply-primary-replacement",
      job: "sync-stablecoins",
      message: "Replaced zero-supply primary rows with positive supplemental coverage",
      metadata: { replacedIds: primaryReplacement.replacedIds },
    });
  }

  const supplementalResolution = mergeSupplementalLastKnownGood(
    supplementalAssets,
    previousAssetsById,
    new Set(assets.map((asset) => String(asset.id))),
    input.syncStartSec,
  );
  if (supplementalResolution.assets.length > 0) {
    assets = [...assets, ...supplementalResolution.assets];
  }
  if (supplementalResolution.restoredCount > 0 || supplementalResolution.skippedDuplicates > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "info",
      event: "supplemental-resolution",
      message: "Resolved supplemental assets",
      metadata: {
        restoredCount: supplementalResolution.restoredCount,
        skippedDuplicates: supplementalResolution.skippedDuplicates,
      },
    });
  }
  if (supplementalResolution.expiredRestoreIds.length > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "supplemental-carry-forward-expired",
      message: "Supplemental supply carry-forward expired past the 7d ceiling; publishing without restored supply",
      metadata: { expiredRestoreIds: supplementalResolution.expiredRestoreIds },
    });
  }

  // Restore-or-degrade on tracked-id coverage: a DefiLlama list omission must
  // not silently drop a tracked coin from the published payload for a cycle.
  const trackedCoverage = restoreMissingTrackedAssets(
    assets,
    previousAssetsById,
    input.syncStartSec,
  );
  if (trackedCoverage.assets.length > 0) {
    assets = [...assets, ...trackedCoverage.assets];
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "tracked-assets-restored",
      message: "Intake omitted tracked coins; restored last-known-good rows",
      metadata: { restoredIds: trackedCoverage.restoredIds },
    });
  }
  if (trackedCoverage.droppedIds.length > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      event: "tracked-assets-unrestorable",
      message: "Tracked coins are missing from intake with no restorable row; publishing without them",
      metadata: { droppedIds: trackedCoverage.droppedIds },
    });
  }

  applyTrackedAssetOverrides(assets);

  const supplyGapReconciliation = await reconcileTrackedSupplyGaps(
    assets,
    input.signal,
    input.coingeckoApiKey,
    input.chainRpcs,
    input.fxFallbackRates,
  );
  if (supplyGapReconciliation.totalReconciled > 0) {
    logWorkerEvent({
      scope: "lib",
      job: "sync-stablecoins",
      level: "warn",
      event: "supply-gaps-reconciled",
      message: "Reconciled tracked supply gaps from gap repair",
      metadata: {
        totalReconciled: supplyGapReconciliation.totalReconciled,
        reconciledIds: supplyGapReconciliation.reconciledIds,
      },
    });
  }

  return {
    kind: "main",
    assets,
    rawAssetCount,
    droppedMalformedAssets,
    canonicalDeduplication,
    fxFallbackRates: dlFxFallbackRates,
    previousAssetsById,
    previousCacheState,
    cgData,
    supplyGapReconciliation,
    trackedCoverage,
  };
}
